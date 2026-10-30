import { metrics, type Meter } from '@opentelemetry/api';
import type { IntentType } from '@arenal/domain';

export type IntentOutcome = 'applied' | 'duplicate' | 'rejected';

/**
 * Métricas propias del juego. Se crean sobre la API de OpenTelemetry: sin un SDK registrado
 * (pruebas, desarrollo local) cada llamada es un no-op; en Azure llegan a Application Insights.
 */
export interface GameMetrics {
  /** Una intención procesada por el almacén de partidas: jugadas, temporizadores, abandonos. */
  intentProcessed(intent: IntentType, outcome: IntentOutcome, durationMs: number, code?: string): void;
  /** Tiempo entre que una réplica publica un evento y otra (o la misma) se lo manda a un jugador. */
  eventDelivered(lagMs: number): void;
  /** Mensaje de WebSocket rechazado antes de llegar al dominio (validación o límite de tasa). */
  messageRejected(code: string): void;
}

/** Límites de los histogramas en ms: la meta del proyecto es p95 < 200 ms. */
const LATENCY_BUCKETS_MS = [1, 2, 5, 10, 20, 50, 100, 150, 200, 300, 500, 1000, 2000];

export function createGameMetrics(meter: Meter = metrics.getMeter('arenal-server')): GameMetrics {
  const intents = meter.createCounter('arenal.intents', {
    description: 'Intenciones procesadas (jugadas, temporizadores, abandonos, cierres de administración)',
    unit: '{intent}',
  });
  const intentDuration = meter.createHistogram('arenal.intent.duration', {
    description: 'Tiempo de procesar una intención: bloqueo, validación, guardado y aviso a las réplicas',
    unit: 'ms',
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS_MS },
  });
  const deliveryLag = meter.createHistogram('arenal.event.delivery_lag', {
    description: 'Desde que se publica un evento hasta que sale por el WebSocket de cada jugador',
    unit: 'ms',
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS_MS },
  });
  const rejected = meter.createCounter('arenal.ws.rejected', {
    description: 'Mensajes de WebSocket rechazados antes de llegar al dominio',
    unit: '{message}',
  });

  return {
    intentProcessed(intent, outcome, durationMs, code) {
      const attributes = { 'arenal.intent': intent, 'arenal.outcome': outcome, ...(code && { 'arenal.code': code }) };
      intents.add(1, attributes);
      intentDuration.record(durationMs, { 'arenal.intent': intent, 'arenal.outcome': outcome });
    },
    eventDelivered(lagMs) {
      deliveryLag.record(Math.max(0, lagMs));
    },
    messageRejected(code) {
      rejected.add(1, { 'arenal.code': code });
    },
  };
}

/**
 * Indicadores que se leen cuando el SDK exporta (cada minuto): conexiones de esta réplica y
 * partidas activas en total (es el mismo número en todas las réplicas; en los gráficos se usa
 * el máximo).
 */
export function observeGauges(
  sources: { connections: () => number; activeMatches: () => Promise<number> },
  meter: Meter = metrics.getMeter('arenal-server'),
): void {
  meter
    .createObservableGauge('arenal.ws.connections', {
      description: 'Conexiones WebSocket abiertas en esta réplica',
      unit: '{connection}',
    })
    .addCallback((result) => {
      result.observe(sources.connections());
    });
  meter
    .createObservableGauge('arenal.matches.active', {
      description: 'Partidas en curso (todas las réplicas)',
      unit: '{match}',
    })
    .addCallback(async (result) => {
      result.observe(await sources.activeMatches());
    });
}
