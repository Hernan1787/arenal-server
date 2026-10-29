import type { Tx } from '../db/tx.js';
import { conflict, notFound } from '../errors.js';

/**
 * Bloquea la fila del usuario durante la transacción. Todas las operaciones que lo meten en
 * una sala, en la cola o en una partida pasan por aquí, así que para un mismo usuario
 * corren de a una y no puede quedar en dos lugares por una carrera.
 */
export async function lockUser(tx: Tx, userId: string): Promise<void> {
  const { rowCount } = await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (rowCount !== 1) throw notFound('El usuario');
}

/** Falla si el usuario ya está en una sala, en la cola o jugando una partida. */
export async function ensureAvailable(tx: Tx, userId: string): Promise<void> {
  const { rows } = await tx.query<{ in_room: boolean; queued: boolean; playing: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM room_members WHERE user_id = $1) AS in_room,
            EXISTS (SELECT 1 FROM matchmaking_tickets WHERE user_id = $1 AND status = 'waiting') AS queued,
            EXISTS (SELECT 1 FROM match_players WHERE user_id = $1 AND active) AS playing`,
    [userId],
  );
  const state = rows[0];
  if (state?.playing === true) throw conflict('ALREADY_IN_MATCH', 'Ya estás jugando una partida');
  if (state?.in_room === true) throw conflict('ALREADY_IN_ROOM', 'Ya estás en una sala; sal de ella primero');
  if (state?.queued === true) throw conflict('ALREADY_QUEUED', 'Ya estás en la cola de emparejamiento');
}
