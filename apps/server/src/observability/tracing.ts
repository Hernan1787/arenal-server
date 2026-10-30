import {
  isSpanContextValid,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type SpanKind,
} from '@opentelemetry/api';

const tracer = () => trace.getTracer('arenal-server');

/** Atributos con los que se buscan las trazas de una partida o de un jugador. */
export const attr = {
  matchId: 'arenal.match.id',
  playerId: 'arenal.player.id',
  intent: 'arenal.intent',
  outcome: 'arenal.outcome',
  code: 'arenal.code',
  seq: 'arenal.seq',
  stateSource: 'arenal.state_source',
} as const;

/**
 * Corre `work` dentro de un span activo: las consultas a Postgres y Redis que haga quedan como
 * hijas, y los logs de pino dentro llevan su trace_id. Si `work` lanza, el span queda en error.
 */
export function withSpan<T>(
  name: string,
  options: { attributes?: Attributes; kind?: SpanKind },
  work: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, options, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Campos de la traza activa para los logs; vacío si no hay traza (local, pruebas). */
export function traceFields(): { trace_id?: string; span_id?: string } {
  const context = trace.getActiveSpan()?.spanContext();
  return context !== undefined && isSpanContextValid(context)
    ? { trace_id: context.traceId, span_id: context.spanId }
    : {};
}
