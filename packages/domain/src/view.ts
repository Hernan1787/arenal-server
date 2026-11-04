import type { EliminationReason, GameState, MatchResult, MatchStatus } from './state.js';
import type { Card, CardFace, PlayerId } from './types.js';

export interface PublicPlayer {
  readonly id: PlayerId;
  readonly seat: number;
  readonly lives: number;
  /** De los demás solo se sabe cuántas cartas tienen, nunca cuáles. */
  readonly handCount: number;
  readonly eliminated: boolean;
  readonly eliminationReason: EliminationReason | null;
  /** Tiene un Escudo puesto (se ve porque el Escudo se juega boca arriba). */
  readonly shielded: boolean;
}

export interface OwnInfo {
  readonly id: PlayerId;
  readonly hand: readonly Card[];
  /** Lectura del sismógrafo de esta ronda, si la hubo. Solo la ve quien la pidió. */
  readonly seismo: { readonly near: boolean } | null;
  /** Lo que vio con Ceniza en esta ronda: de quién y qué carta (sin su ID). */
  readonly peek: { readonly targetId: PlayerId; readonly card: CardFace } | null;
}

export interface PublicRules {
  readonly startingLives: number;
  readonly handSize: number;
  readonly limitMin: number;
  readonly limitMax: number;
  readonly coolAmount: number;
  readonly rainAmount: number;
  readonly bombAmount: number;
  readonly quakeMin: number;
  readonly quakeMax: number;
  readonly seismoThreshold: number;
  readonly maxRounds: number;
}

/** Lo único que un jugador puede ver de la partida. Nunca incluye el límite secreto ni el mazo. */
export interface PlayerView {
  readonly matchId: string;
  readonly status: MatchStatus;
  readonly version: number;
  readonly round: number;
  readonly turn: number;
  readonly currentPlayer: PlayerId | null;
  /** Cartas que le quedan por jugar al jugador de turno (2 después de un Desvío). */
  readonly playsLeft: number;
  readonly pressure: number;
  readonly lastRevealedLimit: number | null;
  readonly drawPileCount: number;
  readonly discardCount: number;
  readonly players: readonly PublicPlayer[];
  /** `null` cuando quien mira no juega la partida (por ejemplo, un administrador). */
  readonly you: OwnInfo | null;
  readonly rules: PublicRules;
  readonly result: MatchResult | null;
}

export function viewFor(state: GameState, viewerId: PlayerId | null): PlayerView {
  const me = viewerId === null ? undefined : state.players.find((p) => p.id === viewerId);
  const { config } = state;
  return {
    matchId: state.matchId,
    status: state.status,
    version: state.version,
    round: state.round,
    turn: state.turn,
    currentPlayer: state.currentPlayer,
    playsLeft: state.playsLeft,
    pressure: state.pressure,
    lastRevealedLimit: state.lastRevealedLimit,
    drawPileCount: state.drawPile.length,
    discardCount: state.discard.length,
    players: state.players.map((p) => ({
      id: p.id,
      seat: p.seat,
      lives: p.lives,
      handCount: p.hand.length,
      eliminated: p.eliminated,
      eliminationReason: p.eliminationReason,
      shielded: p.shielded,
    })),
    you:
      me === undefined
        ? null
        : {
            id: me.id,
            hand: me.hand,
            seismo: me.lastSeismo?.round === state.round ? { near: me.lastSeismo.near } : null,
            peek:
              me.lastPeek?.round === state.round ? { targetId: me.lastPeek.targetId, card: me.lastPeek.card } : null,
          },
    rules: {
      startingLives: config.startingLives,
      handSize: config.handSize,
      limitMin: config.limitMin,
      limitMax: config.limitMax,
      coolAmount: config.coolAmount,
      rainAmount: config.rainAmount,
      bombAmount: config.bombAmount,
      quakeMin: config.quakeMin,
      quakeMax: config.quakeMax,
      seismoThreshold: config.seismoThreshold,
      maxRounds: config.maxRounds,
    },
    result: state.result,
  };
}
