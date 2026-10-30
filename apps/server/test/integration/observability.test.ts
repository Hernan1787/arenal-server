import { randomUUID } from 'node:crypto';
import type { ServerMessage } from '@arenal/contracts';
import { metrics, trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterAll, describe, expect, it } from 'vitest';
import { observeGauges } from '../../src/observability/metrics.js';
import { traceFields, withSpan } from '../../src/observability/tracing.js';
import { registerUsers, useHarness, type TestUser } from './harness.js';
import { play, ticketFor, TestSocket } from './ws-client.js';

// SDK en memoria, registrado antes de que el arnés cree los servicios (como hace instrument.ts).
const spans = new InMemorySpanExporter();
new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }).register();
const exported = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({ exporter: exported, exportIntervalMillis: 3_600_000 });
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

const h = useHarness({ realtime: true });

// Los proveedores son globales del proceso: se quitan para no afectar a otros archivos de pruebas.
afterAll(() => {
  trace.disable();
  metrics.disable();
});

async function collect(): Promise<MetricData[]> {
  exported.reset();
  await reader.forceFlush();
  return exported.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics));
}

const find = (all: MetricData[], name: string): MetricData | undefined => all.find((m) => m.descriptor.name === name);

async function startMatch(): Promise<{ matchId: string; ana: TestUser; beto: TestUser }> {
  const [ana, beto] = await registerUsers(h.app, 2);
  if (ana === undefined || beto === undefined) throw new Error('faltan usuarios');
  const room = (
    await h.app.inject({ method: 'POST', url: '/v1/rooms', headers: ana.auth, payload: { visibility: 'public' } })
  ).json<{ id: string }>();
  await h.app.inject({ method: 'POST', url: `/v1/rooms/${room.id}/join`, headers: beto.auth });
  await h.app.inject({ method: 'PUT', url: `/v1/rooms/${room.id}/ready`, headers: ana.auth, payload: { ready: true } });
  const started = await h.app.inject({
    method: 'PUT',
    url: `/v1/rooms/${room.id}/ready`,
    headers: beto.auth,
    payload: { ready: true },
  });
  return { matchId: started.json<{ matchId: string }>().matchId, ana, beto };
}

describe('observabilidad', () => {
  it('una jugada deja su traza con la partida y el jugador, y alimenta las métricas propias', async () => {
    const { matchId, ana, beto } = await startMatch();
    const sockets = new Map([
      [ana.id, await TestSocket.open(h.baseUrl, await ticketFor(h.app, ana))],
      [beto.id, await TestSocket.open(h.baseUrl, await ticketFor(h.app, beto))],
    ]);
    for (const s of sockets.values()) await s.next((m) => m.type === 'snapshot');

    const loaded = await h.services.store.load(matchId);
    const playerId = loaded?.state.currentPlayer ?? '';
    const cardId = loaded?.state.players.find((p) => p.id === playerId)?.hand[0]?.id ?? '';
    const socket = sockets.get(playerId);
    if (socket === undefined || loaded === undefined) throw new Error('sin turno');
    spans.reset();
    const moveId = randomUUID();
    socket.send(play(matchId, cardId, loaded.row.seq, moveId));
    await socket.next((m: ServerMessage) => m.type === 'ack' && m.id === moveId);
    const rival = [...sockets.entries()].find(([id]) => id !== playerId)?.[1];
    await rival?.next((m) => m.type === 'event');
    socket.sendRaw('{esto no es json');
    await socket.next((m) => m.type === 'error');

    // Traza: el mensaje del WebSocket y, adentro, la intención aplicada.
    await expect.poll(() => spans.getFinishedSpans().some((s) => s.name === 'ws play_card')).toBe(true);
    const finished = spans.getFinishedSpans();
    const wsSpan = finished.find((s) => s.name === 'ws play_card');
    const applySpan = finished.find((s) => s.name === 'match.apply');
    expect(wsSpan?.attributes).toMatchObject({ 'arenal.match.id': matchId, 'arenal.player.id': playerId });
    expect(applySpan?.attributes).toMatchObject({
      'arenal.match.id': matchId,
      'arenal.player.id': playerId,
      'arenal.intent': 'play_card',
      'arenal.outcome': 'applied',
    });
    expect(applySpan?.parentSpanContext?.spanId).toBe(wsSpan?.spanContext().spanId);
    // Ningún atributo lleva la carta jugada ni nada de la mano.
    expect(JSON.stringify(finished.map((s) => s.attributes))).not.toContain(cardId);

    // Métricas propias.
    const all = await collect();
    const intents = find(all, 'arenal.intents');
    const applied = intents?.dataPoints.find(
      (p) => p.attributes['arenal.intent'] === 'play_card' && p.attributes['arenal.outcome'] === 'applied',
    );
    expect(applied?.value).toBeGreaterThanOrEqual(1);
    const duration = find(all, 'arenal.intent.duration')?.dataPoints[0]?.value;
    expect(duration).toMatchObject({ count: expect.any(Number) as unknown });
    const lag = find(all, 'arenal.event.delivery_lag')?.dataPoints[0]?.value as { count: number } | undefined;
    expect(lag?.count).toBeGreaterThanOrEqual(2);
    const rejected = find(all, 'arenal.ws.rejected')?.dataPoints.find(
      (p) => p.attributes['arenal.code'] === 'INVALID_MESSAGE',
    );
    expect(rejected?.value).toBe(1);

    for (const s of sockets.values()) await s.close();
  });

  it('los indicadores leen las conexiones de la réplica y las partidas activas', async () => {
    await startMatch();
    observeGauges({
      connections: () => h.realtime?.connectionCount ?? 0,
      activeMatches: async () => {
        const { rows } = await h.db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM matches WHERE status = 'playing'",
        );
        return rows[0]?.n ?? 0;
      },
    });
    const all = await collect();
    expect(find(all, 'arenal.matches.active')?.dataPoints[0]?.value).toBe(1);
    expect(find(all, 'arenal.ws.connections')?.dataPoints[0]?.value).toBe(0);
  });

  it('los logs dentro de una traza llevan su trace_id; fuera de una traza, nada', async () => {
    expect(traceFields()).toEqual({});
    const inside = await withSpan('prueba', {}, (span) =>
      Promise.resolve({ fields: traceFields(), traceId: span.spanContext().traceId }),
    );
    expect(inside.fields.trace_id).toBe(inside.traceId);
    expect(inside.fields.span_id).toMatch(/^[0-9a-f]{16}$/);
  });
});
