// Bots de práctica que corren en esta misma pestaña. Cada uno es un jugador de verdad para el
// servidor (su propia cuenta temporal, su WebSocket y su vista filtrada): entran a una sala
// privada con el código y juegan con la estrategia de @arenal/client, pensando un poco antes de
// cada jugada. El servidor no sabe que son bots ni les da nada especial.

import { ArenalApi, choosePlay, isMyTurn, ReconnectingSession, RejectedError, type Room } from '@arenal/client';
import type { PlayerView } from '@arenal/domain';

const BOTS_KEY = 'arenal.bots';
const NAMES = ['Bot Tucán', 'Bot Perezoso', 'Bot Rana'] as const;
export const MAX_BOTS = NAMES.length;

interface BotAccount {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

interface Bot {
  readonly id: string;
  readonly name: string;
  readonly api: ArenalApi;
  readonly link: ReconnectingSession;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Entre 1,2 y 2,6 segundos: lo bastante para seguir la jugada sin que la partida se haga eterna. */
const thinkMs = (): number => 1200 + Math.random() * 1400;

function savedAccounts(): BotAccount[] {
  try {
    const raw = sessionStorage.getItem(BOTS_KEY);
    return raw === null ? [] : (JSON.parse(raw) as BotAccount[]);
  } catch {
    return [];
  }
}

function saveAccounts(accounts: readonly BotAccount[]): void {
  try {
    sessionStorage.setItem(BOTS_KEY, JSON.stringify(accounts));
  } catch {
    // Sin almacenamiento, al recargar se crean bots nuevos.
  }
}

export class Practice {
  private readonly bots: Bot[] = [];

  constructor(private readonly origin: string) {}

  /** ¿Hay bots guardados de esta pestaña? (Por ejemplo, se recargó a mitad de una partida.) */
  static hasSaved(): boolean {
    return savedAccounts().length > 0;
  }

  /**
   * Arma una sala privada con `count` bots y le pone «listo» a todos. `host` es la API del
   * jugador; la partida empieza cuando él también marca listo (lo hace esta función al final).
   */
  async start(host: ArenalApi, count: number): Promise<Room> {
    await this.ensureBots(count);
    const room = await host.createRoom({ visibility: 'private', capacity: count + 1 });
    const code = room.inviteCode;
    if (code === null) throw new Error('La sala no tiene código');
    const bots = this.bots.slice(0, count);
    // Primero entran todos y después marcan listo: cuando alguien entra, la sala les quita el
    // «listo» a los demás (para que nadie empiece sin ver quién llegó).
    for (const bot of bots) await bot.api.joinByCode(code);
    for (const bot of bots) await bot.api.setReady(room.id, true);
    return host.setReady(room.id, true);
  }

  /** Vuelve a conectar los bots guardados, para que sigan la partida en curso después de recargar. */
  async resume(): Promise<void> {
    const saved = savedAccounts().length;
    if (saved > 0) await this.ensureBots(saved);
  }

  stop(): void {
    for (const bot of this.bots) {
      clearTimeout(bot.timer);
      bot.link.close();
    }
    this.bots.length = 0;
  }

  private async ensureBots(count: number): Promise<void> {
    const accounts = savedAccounts();
    for (let i = this.bots.length; i < Math.min(count, MAX_BOTS); i++) {
      const bot = await this.connectBot(accounts[i], NAMES[i] ?? `Bot ${i + 1}`);
      accounts[i] = bot.account;
      this.bots.push(bot.bot);
    }
    saveAccounts(accounts);
  }

  private async connectBot(saved: BotAccount | undefined, name: string): Promise<{ bot: Bot; account: BotAccount }> {
    const api = new ArenalApi(this.origin);
    let account = saved;
    let id: string | undefined;
    if (account !== undefined) {
      try {
        id = (await api.login({ email: account.email, password: account.password })).user.id;
      } catch {
        // La cuenta ya no existe (por ejemplo, se reconstruyó la base): se crea otra.
        account = undefined;
      }
    }
    if (account === undefined || id === undefined) {
      const suffix = crypto.randomUUID().slice(0, 12);
      account = { email: `bot-${suffix}@jugadores.arenal.invalid`, password: `b-${crypto.randomUUID()}`, name };
      id = (await api.register({ email: account.email, password: account.password, displayName: name })).user.id;
    }

    const holder: { bot?: Bot } = {};
    const consider = (view: PlayerView): void => {
      const bot = holder.bot;
      if (bot !== undefined) this.consider(bot, view);
    };
    const link = await ReconnectingSession.open(api, {
      onSnapshot: consider,
      onEvent: (_event, _seq, view) => {
        consider(view);
      },
    });
    const bot: Bot = { id, name: account.name, api, link, timer: undefined };
    holder.bot = bot;
    if (link.current.view !== null) consider(link.current.view);
    return { bot, account };
  }

  /** Si le toca, piensa un rato y juega sobre la vista que tenga en ese momento. */
  private consider(bot: Bot, view: PlayerView): void {
    clearTimeout(bot.timer);
    if (!isMyTurn(view)) return;
    bot.timer = setTimeout(() => {
      const socket = bot.link.current;
      const current = socket.view;
      const play = isMyTurn(current) ? choosePlay(current) : undefined;
      if (play === undefined) return;
      socket.playCard(play.card.id, play.targetId).catch((error: unknown) => {
        // STALE_STATE: llegó un evento mientras pensaba; el evento ya lo vuelve a poner a pensar.
        if (error instanceof RejectedError && error.code === 'STALE_STATE') return;
        setTimeout(() => {
          if (socket.view !== null) this.consider(bot, socket.view);
        }, 800);
      });
    }, thinkMs());
  }
}
