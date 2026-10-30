/**
 * Prueba de carga con partidas reales por WebSocket.
 *
 *   pnpm load --url http://localhost:8080 --matches 50 --players 2 --duration 60 --think 250
 *   pnpm load --url … --ramp 25,50,100,200 --duration 60      # escalones hasta el punto de quiebre
 *   pnpm load --url … --matches 50 --pid <pid del servidor>   # además mide CPU y memoria (Linux)
 *
 * Cada mesa juega partidas completas una tras otra. Por cada jugada se mide la latencia de punta
 * a punta: desde que el jugador manda la carta hasta que **todos** los jugadores de la mesa
 * recibieron el último evento de esa jugada. También cuenta jugadas perdidas (con `ack` pero sin
 * evento en algún jugador), duplicadas, huecos en la secuencia y errores.
 *
 * El servidor necesita límites de registro altos para crear tantos usuarios desde una sola IP:
 * RATE_LIMIT_AUTH_PER_MINUTE=100000 (ver docs/load-test.md).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chooseCard, isMyTurn, RejectedError, type RealtimeSession } from '@arenal/client';
import type { PlayerView } from '@arenal/domain';
import { arg, connect, createPlayers, sleep, startRoomMatch, type Player } from './players.js';

const url = arg('url', 'http://localhost:8080');
const playersPerMatch = Number(arg('players', '2'));
const durationS = Number(arg('duration', '60'));
const thinkMs = Number(arg('think', '250'));
const pid = arg('pid', '');
/**
 * PIDs de Postgres para medir también la CPU de la base: una lista separada por comas, o `auto`
 * para tomar todos los procesos `postgres` de la máquina al empezar cada escalón.
 */
const dbPidsArg = arg('db-pids', '');
const dbPids = (): string[] =>
  dbPidsArg === 'auto'
    ? readdirSync('/proc').filter((entry) => {
        if (!/^\d+$/.test(entry)) return false;
        try {
          return readFileSync(`/proc/${entry}/comm`, 'utf8').trim() === 'postgres';
        } catch {
          return false;
        }
      })
    : dbPidsArg
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '');
const label = arg('label', '');
const stages = arg('ramp', arg('matches', '10'))
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => n > 0);

const GOAL_P95_MS = 200;
const GOAL_ERROR_RATE = 0.01;
const DELIVERY_TIMEOUT_MS = 10_000;

interface StageResult {
  readonly matches: number;
  readonly players: number;
  readonly durationS: number;
  readonly thinkMs: number;
  readonly moves: number;
  readonly movesPerSecond: number;
  readonly latencyMs: { p50: number; p95: number; p99: number; max: number; mean: number };
  readonly lostMoves: number;
  readonly duplicateAcks: number;
  /** Jugadas que el servidor frenó por el límite de mensajes por conexión (se reintentan). */
  readonly rateLimited: number;
  readonly sequenceGaps: number;
  readonly invalidMessages: number;
  readonly errors: number;
  readonly errorRate: number;
  readonly finishedMatches: number;
  readonly server: { cpuPercentAvg: number; cpuPercentMax: number; rssMbAvg: number; rssMbMax: number } | null;
  readonly database: { cpuPercentAvg: number; cpuPercentMax: number } | null;
  readonly meetsGoals: boolean;
}

const percentile = (sorted: readonly number[], p: number): number =>
  sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0);

/**
 * Muestrea CPU y memoria de procesos locales leyendo /proc (solo Linux). Con varios PIDs suma
 * la CPU (por ejemplo, todos los procesos de Postgres). 100 % es un núcleo completo.
 */
function sampleProcess(processIds: readonly string[]): () => { cpu: number[]; rss: number[]; stop: () => void } {
  return () => {
    const cpu: number[] = [];
    const rss: number[] = [];
    const ticksPerSecond = 100;
    const readOne = (processId: string): { ticks: number; rssMb: number } => {
      try {
        const stat = readFileSync(`/proc/${processId}/stat`, 'utf8').split(') ')[1]?.split(' ') ?? [];
        const ticks = Number(stat[11]) + Number(stat[12]);
        const status = readFileSync(`/proc/${processId}/status`, 'utf8');
        const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
        return { ticks, rssMb: rssKb / 1024 };
      } catch {
        return { ticks: 0, rssMb: 0 };
      }
    };
    const read = (): { ticks: number; rssMb: number } =>
      processIds.map(readOne).reduce((a, b) => ({ ticks: a.ticks + b.ticks, rssMb: a.rssMb + b.rssMb }));
    let last = read();
    let lastAt = Date.now();
    const timer = setInterval(() => {
      const now = read();
      const at = Date.now();
      cpu.push(((now.ticks - last.ticks) / ticksPerSecond / ((at - lastAt) / 1000)) * 100);
      rss.push(now.rssMb);
      last = now;
      lastAt = at;
    }, 1000);
    return {
      cpu,
      rss,
      stop: () => {
        clearInterval(timer);
      },
    };
  };
}

class Table {
  private readonly sockets = new Map<string, RealtimeSession>();
  private readonly pending: { seq: number; sentAt: number }[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  finished = 0;
  private stopped = false;
  private currentMatch: string | null = null;
  private matchDone: (() => void) | null = null;

  constructor(
    readonly players: readonly Player[],
    private readonly stats: {
      latencies: number[];
      errors: number;
      lost: number;
      duplicates: number;
      rateLimited: number;
    },
  ) {}

  async open(): Promise<void> {
    for (const player of this.players) {
      const socket = await connect(player, {
        onSnapshot: (view) => {
          this.consider(player, view);
        },
        onEvent: (event, _seq, view) => {
          this.settle();
          if (event.type === 'MatchEnded') {
            // Cada jugador recibe el fin; la partida cuenta una vez, y solo la que está en juego.
            if (view.matchId === this.currentMatch) {
              this.currentMatch = null;
              this.finished += 1;
              this.matchDone?.();
            }
            return;
          }
          this.consider(player, view);
        },
        onClose: (code) => {
          if (!this.stopped) this.stats.errors += 1;
          if (code !== 1000 && !this.stopped) console.error(`conexión cerrada (${code})`);
        },
      });
      this.sockets.set(player.id, socket);
    }
  }

  /** Juega partidas una tras otra hasta `deadline`. */
  async run(deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      const ended = new Promise<void>((resolve) => {
        this.matchDone = resolve;
      });
      try {
        this.currentMatch = await startRoomMatch(this.players);
      } catch (error) {
        this.stats.errors += 1;
        console.error('no se pudo armar la partida:', String(error));
        await sleep(1000);
        continue;
      }
      await Promise.race([ended, sleep(Math.max(0, deadline - Date.now()))]);
      // Se acabó el tiempo con la partida en juego: no se arma otra.
      if (this.isPlaying()) break;
    }
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
  }

  /** Un método y no el campo directo: cambia mientras se espera, y así TypeScript no lo da por fijo. */
  private isPlaying(): boolean {
    return this.currentMatch !== null;
  }

  /**
   * Cierra la mesa. Si quedó una partida a medias (se acabó el tiempo), los jugadores la
   * abandonan: así terminan de inmediato y quedan libres para el escalón siguiente.
   */
  async close(): Promise<{ gaps: number; invalid: number }> {
    this.stopped = true;
    let gaps = 0;
    let invalid = 0;
    for (const s of this.sockets.values()) {
      if (s.view?.status === 'playing') await s.leaveMatch().catch(() => undefined);
    }
    for (const s of this.sockets.values()) {
      gaps += s.gaps;
      invalid += s.invalidMessages;
      s.close();
    }
    return { gaps, invalid };
  }

  /** Cuenta una jugada como entregada cuando todos los jugadores tienen su último evento. */
  private settle(): void {
    const reached = Math.min(...[...this.sockets.values()].map((s) => s.seq));
    const now = performance.now();
    while (this.pending.length > 0 && (this.pending[0]?.seq ?? Infinity) <= reached) {
      const move = this.pending.shift();
      if (move !== undefined) this.stats.latencies.push(now - move.sentAt);
    }
    while (this.pending.length > 0 && now - (this.pending[0]?.sentAt ?? now) > DELIVERY_TIMEOUT_MS) {
      this.pending.shift();
      this.stats.lost += 1;
    }
  }

  private consider(player: Player, view: PlayerView): void {
    if (this.stopped || !isMyTurn(view)) return;
    clearTimeout(this.timers.get(player.id));
    this.timers.set(
      player.id,
      setTimeout(() => {
        const socket = this.sockets.get(player.id);
        const current = socket?.view ?? null;
        const card = isMyTurn(current) ? chooseCard(current) : undefined;
        if (socket === undefined || card === undefined || this.stopped) return;
        const sentAt = performance.now();
        socket.playCard(card.id).then(
          (ack) => {
            if (ack.duplicate) this.stats.duplicates += 1;
            this.pending.push({ seq: ack.seq, sentAt });
            this.settle();
          },
          (error: unknown) => {
            // STALE_STATE es parte del protocolo (llegó un evento mientras «pensaba»), no un error.
            // RATE_LIMITED tampoco: el servidor pide bajar el ritmo y se reintenta.
            if (error instanceof RejectedError && error.code === 'RATE_LIMITED') {
              this.stats.rateLimited += 1;
              setTimeout(() => {
                if (socket.view !== null) this.consider(player, socket.view);
              }, 500);
              return;
            }
            if (error instanceof RejectedError && error.retryable) return;
            if (!this.stopped) this.stats.errors += 1;
          },
        );
      }, thinkMs),
    );
  }
}

async function runStage(matches: number, pool: Player[]): Promise<StageResult> {
  const stats = { latencies: [] as number[], errors: 0, lost: 0, duplicates: 0, rateLimited: 0 };
  const tables: Table[] = [];
  for (let i = 0; i < matches; i++) {
    tables.push(new Table(pool.slice(i * playersPerMatch, (i + 1) * playersPerMatch), stats));
  }
  for (const t of tables) await t.open();

  const sampler = pid === '' ? null : sampleProcess([pid])();
  const databasePids = dbPids();
  const dbSampler = databasePids.length === 0 ? null : sampleProcess(databasePids)();
  const started = Date.now();
  const deadline = started + durationS * 1000;
  await Promise.all(tables.map((t) => t.run(deadline)));
  const elapsedS = (Date.now() - started) / 1000;
  sampler?.stop();
  dbSampler?.stop();
  await sleep(500);

  let gaps = 0;
  let invalid = 0;
  for (const t of tables) {
    const c = await t.close();
    gaps += c.gaps;
    invalid += c.invalid;
  }
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const moves = sorted.length;
  const errors = stats.errors + stats.lost;
  const errorRate = moves + errors === 0 ? 0 : errors / (moves + errors);
  const round = (n: number): number => Math.round(n * 10) / 10;
  const avg = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  const latencyMs = {
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.at(-1) ?? 0),
    mean: round(avg(sorted)),
  };
  return {
    matches,
    players: matches * playersPerMatch,
    durationS: round(elapsedS),
    thinkMs,
    moves,
    movesPerSecond: round(moves / elapsedS),
    latencyMs,
    lostMoves: stats.lost,
    duplicateAcks: stats.duplicates,
    rateLimited: stats.rateLimited,
    sequenceGaps: gaps,
    invalidMessages: invalid,
    errors,
    errorRate: Math.round(errorRate * 10_000) / 10_000,
    finishedMatches: tables.reduce((n, t) => n + t.finished, 0),
    server:
      sampler === null
        ? null
        : {
            cpuPercentAvg: round(avg(sampler.cpu)),
            cpuPercentMax: round(Math.max(0, ...sampler.cpu)),
            rssMbAvg: round(avg(sampler.rss)),
            rssMbMax: round(Math.max(0, ...sampler.rss)),
          },
    database:
      dbSampler === null
        ? null
        : { cpuPercentAvg: round(avg(dbSampler.cpu)), cpuPercentMax: round(Math.max(0, ...dbSampler.cpu)) },
    meetsGoals: latencyMs.p95 < GOAL_P95_MS && errorRate < GOAL_ERROR_RATE && stats.lost === 0 && gaps === 0,
  };
}

const needed = Math.max(...stages) * playersPerMatch;
console.log(`Registrando ${needed} jugadores en ${url}…`);
const pool = await createPlayers(url, needed, 'Carga', 20);
const results: StageResult[] = [];
for (const matches of stages) {
  console.log(
    `\n▶ ${matches} partidas simultáneas de ${playersPerMatch} jugadores, ${durationS} s, pausa ${thinkMs} ms`,
  );
  const result = await runStage(matches, pool);
  results.push(result);
  const l = result.latencyMs;
  console.log(
    `  ${result.moves} jugadas (${result.movesPerSecond}/s) · p50 ${l.p50} · p95 ${l.p95} · p99 ${l.p99} · máx ${l.max} ms` +
      ` · errores ${result.errors} (${(result.errorRate * 100).toFixed(2)} %) · perdidas ${result.lostMoves}` +
      ` · huecos ${result.sequenceGaps}${result.server ? ` · CPU ${result.server.cpuPercentAvg} % · RSS ${result.server.rssMbMax} MB` : ''}` +
      (result.database ? ` · CPU Postgres ${result.database.cpuPercentAvg} %` : '') +
      ` · ${result.meetsGoals ? 'cumple' : 'NO cumple'}`,
  );
}
const breaking = results.find((r) => !r.meetsGoals);
console.log(
  breaking === undefined
    ? '\nTodas las etapas cumplen las metas (p95 < 200 ms, errores < 1 %, sin jugadas perdidas).'
    : `\nPunto de quiebre: ${breaking.matches} partidas simultáneas.`,
);

const dir = join(import.meta.dirname, '..', '..', '..', 'load', 'results');
mkdirSync(dir, { recursive: true });
const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}${label ? `-${label}` : ''}.json`);
writeFileSync(file, `${JSON.stringify({ url, playersPerMatch, label, results }, null, 2)}\n`);
console.log(`Resultados: ${file}`);
process.exit(0);
