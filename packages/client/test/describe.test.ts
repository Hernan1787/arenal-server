import { describe, expect, it } from 'vitest';
import { describeEvent } from '../src/describe.js';

const who = (id: string): string => (id === 'yo' ? 'Tú' : id === 'a' ? 'Ana' : id);

describe('descripción de eventos', () => {
  it('habla en segunda persona cuando el evento es de quien mira', () => {
    expect(
      describeEvent(
        {
          type: 'CardPlayed',
          playerId: 'yo',
          card: { id: 'c_1', kind: 'stone', value: 3 },
          pressureAfter: 9,
          auto: false,
        },
        'yo',
        who,
      ),
    ).toBe('Juegas Piedra 3. Presión: 9');
    expect(describeEvent({ type: 'Eruption', playerId: 'yo', limit: 19, livesLeft: 1 }, 'yo', who)).toBe(
      '¡Erupción! El límite era 19. Te queda 1 vida',
    );
    expect(
      describeEvent(
        { type: 'MatchEnded', result: { kind: 'winner', winner: 'yo', reason: 'last_standing' } },
        'yo',
        who,
      ),
    ).toBe('Fin de la partida. ¡Ganaste!');
  });

  it('nombra a los demás y no cuenta lo que no le importa al jugador', () => {
    expect(describeEvent({ type: 'Eruption', playerId: 'a', limit: 22, livesLeft: 0 }, 'yo', who)).toBe(
      '¡Erupción! El límite era 22. Ana se quedó sin vidas',
    );
    expect(describeEvent({ type: 'TurnStarted', playerId: 'a', turn: 4 }, 'yo', who)).toBeNull();
  });
});
