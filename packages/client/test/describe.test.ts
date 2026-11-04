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

  it('cuenta las cartas nuevas y solo da detalles a quien le tocan', () => {
    const quake = { id: 'c_1', kind: 'quake' } as const;
    expect(
      describeEvent(
        { type: 'CardPlayed', playerId: 'a', card: quake, pressureAfter: 12, auto: false, rolled: 3 },
        'yo',
        who,
      ),
    ).toBe('Ana juega Temblor (+3). Presión: 12');
    const ash = { id: 'c_2', kind: 'ash' } as const;
    expect(
      describeEvent(
        { type: 'CardPlayed', playerId: 'a', card: ash, pressureAfter: 12, auto: false, targetId: 'yo' },
        'yo',
        who,
      ),
    ).toBe('Ana juega Ceniza contra ti. Presión: 12');
    const seen = { kind: 'stone', value: 4 } as const;
    expect(describeEvent({ type: 'CardPeeked', playerId: 'yo', targetId: 'a', card: seen }, 'yo', who)).toBe(
      'Ves en la mano de Ana: Piedra 4',
    );
    expect(describeEvent({ type: 'CardPeeked', playerId: 'a', targetId: 'yo', card: seen }, 'yo', who)).toBe(
      'Ana vio tu Piedra 4',
    );
    expect(describeEvent({ type: 'CardStolen', playerId: 'a', targetId: 'b' }, 'yo', who)).toBe(
      'Ana le robó una carta a b',
    );
    expect(describeEvent({ type: 'TurnStarted', playerId: 'yo', turn: 5, playsLeft: 2 }, 'yo', who)).toBe(
      'Desvío: te toca jugar dos cartas',
    );
    expect(describeEvent({ type: 'Eruption', playerId: 'a', limit: 18, livesLeft: 2, shielded: true }, 'yo', who)).toBe(
      '¡Erupción! El límite era 18. El escudo de Ana aguantó',
    );
  });
});
