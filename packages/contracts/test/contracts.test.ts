import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Parser } from '@asyncapi/parser';
import { createMatch, decide, evolve, projectEvent, viewFor, type GameState, type PlayerView } from '@arenal/domain';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { z } from 'zod';
import { EXAMPLES } from '../src/asyncapi.js';
import {
  AckMessage,
  buildAsyncApiDocument,
  ErrorMessage,
  EventMessage,
  LeaveMatchMessage,
  MAX_CLIENT_MESSAGE_BYTES,
  parseClientMessage,
  PlayCardMessage,
  PlayerEventSchema,
  PlayerViewSchema,
  ResumeMessage,
  SnapshotMessage,
} from '../src/index.js';

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

// Chequeo en tiempo de compilación: lo que produce el dominio cabe en el contrato.
const viewFitsContract = (view: PlayerView): DeepReadonly<z.input<typeof PlayerViewSchema>> => view;

const validPlay = EXAMPLES.PlayCard;

describe('validación de mensajes del cliente', () => {
  it('el tipo PlayerView del dominio cabe en el contrato (chequeo en compilación)', () => {
    expect(viewFitsContract).toBeTypeOf('function');
  });

  it('acepta una jugada bien formada', () => {
    expect(parseClientMessage(validPlay).ok).toBe(true);
  });

  it.each([
    ['sin versión', { ...validPlay, v: undefined }],
    ['versión desconocida', { ...validPlay, v: 2 }],
    ['tipo desconocido', { ...validPlay, type: 'win_game' }],
    ['ID que no es UUID', { ...validPlay, id: '123' }],
    ['carta con formato raro', { ...validPlay, payload: { cardId: 'piedra-4' } }],
    ['seq negativo', { ...validPlay, expectedSeq: -1 }],
    ['seq con decimales', { ...validPlay, expectedSeq: 1.5 }],
    ['campos de más (el cliente manda resultados)', { ...validPlay, payload: { cardId: 'c_8f3k2a', points: 10 } }],
    ['campo extra en el sobre', { ...validPlay, score: 99 }],
    ['no es un objeto', 'play_card c_8f3k2a'],
  ])('rechaza: %s', (_case, raw) => {
    expect(parseClientMessage(raw).ok).toBe(false);
  });

  it('el límite de tamaño deja espacio de sobra para el mensaje más grande del cliente', () => {
    expect(JSON.stringify(validPlay).length).toBeLessThan(MAX_CLIENT_MESSAGE_BYTES / 10);
  });
});

describe('ejemplos del contrato', () => {
  it.each([
    ['PlayCard', PlayCardMessage, EXAMPLES.PlayCard],
    ['Resume', ResumeMessage, EXAMPLES.Resume],
    ['LeaveMatch', LeaveMatchMessage, EXAMPLES.LeaveMatch],
    ['Ack', AckMessage, EXAMPLES.Ack],
    ['Event', EventMessage, EXAMPLES.Event],
    ['Snapshot', SnapshotMessage, EXAMPLES.Snapshot],
    ['Error', ErrorMessage, EXAMPLES.Error],
  ] as const)('el ejemplo de %s cumple su esquema', (_name, schema, example) => {
    expect(schema.safeParse(example).success).toBe(true);
  });
});

describe('el dominio y el contrato coinciden', () => {
  it('cada vista y cada evento filtrado de una partida real pasan su esquema', () => {
    let rngState = 12345;
    const rng = {
      int: (min: number, max: number) => {
        rngState = (rngState * 1103515245 + 12345) % 2 ** 31;
        return min + (rngState % (max - min + 1));
      },
    };
    let state: GameState = createMatch('m_contract', ['u_ana', 'u_beto', 'u_caro']);
    const check = (events: Parameters<typeof projectEvent>[0][]): void => {
      for (const event of events) {
        state = evolve(state, event);
        for (const viewer of ['u_ana', 'u_beto', 'u_caro', null]) {
          expect(PlayerEventSchema.safeParse(projectEvent(event, viewer)).success).toBe(true);
          expect(PlayerViewSchema.safeParse(viewFor(state, viewer)).success).toBe(true);
        }
      }
    };

    const start = decide(state, { type: 'start' }, { rng });
    if (!start.ok) throw new Error(start.error.message);
    check(start.value);
    for (let i = 0; i < 400 && state.status === 'playing'; i++) {
      const current = state.players.find((p) => p.id === state.currentPlayer);
      const card = current?.hand[0];
      if (current === undefined || card === undefined) break;
      const result = decide(state, { type: 'play_card', playerId: current.id, cardId: card.id }, { rng });
      if (!result.ok) throw new Error(result.error.message);
      check(result.value);
    }
    expect(state.status).toBe('finished');
  });
});

describe('documento AsyncAPI', () => {
  it('es AsyncAPI 3.0 válido', async () => {
    const parser = new Parser();
    const { diagnostics } = await parser.parse(stringify(buildAsyncApiDocument('0.0.0-test')));
    // Severidad 0 = error en la escala de Spectral (1 = advertencia, 2 = info, 3 = sugerencia).
    const isError = (severity: number): boolean => severity === 0;
    const errors = diagnostics.filter((d) => isError(d.severity));
    expect(errors.map((e) => `${e.path.join('.')}: ${e.message}`)).toEqual([]);
  });

  it('el archivo generado está al día con los esquemas', () => {
    const generated = readFileSync(join(import.meta.dirname, '..', 'generated', 'asyncapi.yaml'), 'utf8');
    const { version } = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(generated).toContain(stringify(buildAsyncApiDocument(version), { lineWidth: 0 }));
  });
});
