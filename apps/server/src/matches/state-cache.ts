import type { GameState } from '@arenal/domain';

/**
 * Caché en memoria del estado de las partidas en curso, por réplica. Evita reconstruir la
 * partida desde todos sus eventos en cada jugada.
 *
 * Es seguro con varias réplicas porque nunca decide nada sola: una entrada solo se usa si su
 * versión es exactamente el `seq` que se leyó de Postgres con la fila bloqueada. Si otra
 * réplica aplicó una jugada, el `seq` ya no coincide y se vuelve a leer de la base.
 */
export class StateCache {
  private readonly entries = new Map<string, GameState>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.entries.size;
  }

  /** El estado en `version`, si está en caché. */
  get(matchId: string, version: number): GameState | undefined {
    const state = this.entries.get(matchId);
    if (state?.version !== version) return undefined;
    // Se reinserta para que el Map quede ordenado del menos al más usado.
    this.entries.delete(matchId);
    this.entries.set(matchId, state);
    return state;
  }

  /** Guarda un estado ya confirmado en Postgres. Nunca reemplaza uno más nuevo. */
  set(matchId: string, state: GameState): void {
    if (this.capacity === 0) return;
    const current = this.entries.get(matchId);
    if (current !== undefined && current.version >= state.version) return;
    this.entries.delete(matchId);
    if (state.status === 'finished') return;
    this.entries.set(matchId, state);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done !== true) this.entries.delete(oldest.value);
    }
  }
}
