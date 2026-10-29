import { randomInt } from 'node:crypto';
import { withTransaction, type Db, type Tx } from '../db/tx.js';
import { conflict, notFound } from '../errors.js';
import { decodeCursor, toPage, type Page } from '../http/pagination.js';
import type { MatchStore } from '../matches/match-store.js';
import { noopBus, type EventBus } from '../realtime/bus.js';
import { ensureAvailable, lockUser } from './availability.js';

export type Visibility = 'public' | 'private';
export type RoomStatus = 'waiting' | 'started' | 'closed';

export interface RoomMember {
  readonly userId: string;
  readonly displayName: string;
  readonly ready: boolean;
}

export interface Room {
  readonly id: string;
  readonly visibility: Visibility;
  /** Solo lo ven los miembros de la sala. */
  readonly inviteCode: string | null;
  readonly capacity: number;
  readonly status: RoomStatus;
  readonly hostId: string;
  readonly members: RoomMember[];
  readonly matchId: string | null;
  readonly createdAt: string;
}

export interface RoomListing {
  readonly id: string;
  readonly capacity: number;
  readonly memberCount: number;
  readonly hostDisplayName: string;
  readonly createdAt: string;
}

interface RoomRow {
  id: string;
  host_id: string;
  visibility: Visibility;
  invite_code: string | null;
  capacity: number;
  member_count: number;
  status: RoomStatus;
  match_id: string | null;
  created_at: Date;
}

/** Alfabeto sin caracteres que se confunden (0/O, 1/I/L). 8 caracteres ≈ 2^39 combinaciones. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newInviteCode = (): string =>
  Array.from({ length: 8 }, () => CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length))).join('');

export class RoomsService {
  private readonly bus: EventBus;

  constructor(private readonly deps: { db: Db; store: MatchStore; bus?: EventBus }) {
    this.bus = deps.bus ?? noopBus;
  }

  async create(userId: string, input: { visibility: Visibility; capacity: number }): Promise<Room> {
    const roomId = await withTransaction(this.deps.db, async (tx) => {
      await lockUser(tx, userId);
      await ensureAvailable(tx, userId);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO rooms (host_id, visibility, invite_code, capacity, member_count) VALUES ($1, $2, $3, $4, 1) RETURNING id`,
        [userId, input.visibility, input.visibility === 'private' ? newInviteCode() : null, input.capacity],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('INSERT sin filas');
      await tx.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)', [id, userId]);
      return id;
    });
    return this.get(roomId, userId);
  }

  /** Salas públicas que esperan jugadores, de la más vieja a la más nueva. */
  async listOpen(query: { limit: number; cursor?: string | undefined }): Promise<Page<RoomListing>> {
    const cursor = decodeCursor(query.cursor);
    const { rows } = await this.deps.db.query<{
      id: string;
      capacity: number;
      member_count: number;
      host_display_name: string;
      created_at: Date;
    }>(
      `SELECT r.id, r.capacity, r.member_count, u.display_name AS host_display_name, r.created_at
         FROM rooms r JOIN users u ON u.id = r.host_id
        WHERE r.status = 'waiting' AND r.visibility = 'public' AND r.member_count < r.capacity
          AND ($1::timestamptz IS NULL OR (r.created_at, r.id) > ($1::timestamptz, $2::uuid))
        ORDER BY r.created_at, r.id
        LIMIT $3`,
      [cursor?.at ?? null, cursor?.id ?? null, query.limit + 1],
    );
    return toPage(
      rows,
      query.limit,
      (r) => ({
        id: r.id,
        capacity: r.capacity,
        memberCount: r.member_count,
        hostDisplayName: r.host_display_name,
        createdAt: r.created_at.toISOString(),
      }),
      (r) => ({ at: r.created_at, id: r.id }),
    );
  }

  /** Una sala privada solo la ven sus miembros; para los demás no existe (404). */
  async get(roomId: string, userId: string): Promise<Room> {
    const room = await this.load(this.deps.db, roomId);
    if (room === undefined) throw notFound('La sala');
    const members = await this.members(this.deps.db, roomId);
    const isMember = members.some((m) => m.userId === userId);
    if (room.visibility === 'private' && !isMember && room.status === 'waiting') throw notFound('La sala');
    return this.toRoom(room, members, isMember);
  }

  async join(roomId: string, userId: string): Promise<Room> {
    await withTransaction(this.deps.db, async (tx) => {
      const room = await this.load(tx, roomId);
      if (room?.visibility !== 'public') throw notFound('La sala');
      await this.addMember(tx, roomId, userId);
    });
    return this.get(roomId, userId);
  }

  async joinByCode(inviteCode: string, userId: string): Promise<Room> {
    const roomId = await withTransaction(this.deps.db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>('SELECT id FROM rooms WHERE invite_code = $1', [
        inviteCode.trim().toUpperCase(),
      ]);
      const id = rows[0]?.id;
      if (id === undefined) throw notFound('La sala');
      await this.addMember(tx, id, userId);
      return id;
    });
    return this.get(roomId, userId);
  }

  /** Sale de la sala. Si sale el anfitrión pasa al miembro más antiguo; si queda vacía, se cierra. */
  async leave(roomId: string, userId: string): Promise<void> {
    await withTransaction(this.deps.db, async (tx) => {
      const room = await this.lockRoom(tx, roomId);
      if (room === undefined || !(await this.removeMember(tx, room, userId))) throw notFound('La sala');
    });
  }

  /**
   * Saca al usuario de la sala en la que esté, dentro de la transacción del llamador (se usa
   * al suspender una cuenta). Devuelve el ID de la sala, o `null` si no estaba en ninguna.
   */
  async removeFromAnyRoom(tx: Tx, userId: string): Promise<string | null> {
    const { rows } = await tx.query<{ room_id: string }>('SELECT room_id FROM room_members WHERE user_id = $1', [
      userId,
    ]);
    const roomId = rows[0]?.room_id;
    if (roomId === undefined) return null;
    const room = await this.lockRoom(tx, roomId);
    // Entre la lectura y el bloqueo la sala pudo arrancar; entonces ya no hay nada que sacar.
    if (room === undefined) return null;
    return (await this.removeMember(tx, room, userId)) ? roomId : null;
  }

  /** Con la sala bloqueada: quita al miembro, pasa el anfitrión al siguiente y cierra la sala si queda vacía. */
  private async removeMember(tx: Tx, room: RoomRow, userId: string): Promise<boolean> {
    const removed = await tx.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [room.id, userId]);
    if (removed.rowCount !== 1) return false;
    if (room.status !== 'waiting') throw conflict('ROOM_NOT_OPEN', 'La sala ya no está esperando jugadores');

    const remaining = await this.members(tx, room.id);
    const nextHost = remaining[0]?.userId;
    await tx.query(
      `UPDATE rooms SET member_count = member_count - 1,
                        status = CASE WHEN member_count - 1 = 0 THEN 'closed' ELSE status END,
                        host_id = COALESCE($2, host_id),
                        updated_at = now()
        WHERE id = $1`,
      [room.id, room.host_id === userId ? (nextHost ?? null) : null],
    );
    return true;
  }

  /**
   * Marca «listo». Cuando hay 2 o más miembros y todos están listos, la sala arranca sola:
   * se crea la partida y los miembros pasan a ella, todo en la misma transacción.
   */
  async setReady(roomId: string, userId: string, ready: boolean): Promise<Room> {
    const started = await withTransaction(
      this.deps.db,
      async (tx): Promise<{ matchId: string; playerIds: string[] } | null> => {
        const room = await this.lockRoom(tx, roomId);
        if (room === undefined) throw notFound('La sala');
        const updated = await tx.query('UPDATE room_members SET ready = $3 WHERE room_id = $1 AND user_id = $2', [
          roomId,
          userId,
          ready,
        ]);
        if (updated.rowCount !== 1) throw notFound('La sala');
        if (room.status !== 'waiting') throw conflict('ROOM_NOT_OPEN', 'La sala ya no está esperando jugadores');

        const members = await this.members(tx, roomId);
        if (members.length >= 2 && members.every((m) => m.ready)) {
          const { matchId } = await this.deps.store.create(
            tx,
            'room',
            members.map((m) => m.userId),
          );
          await tx.query('DELETE FROM room_members WHERE room_id = $1', [roomId]);
          await tx.query(`UPDATE rooms SET status = 'started', match_id = $2, updated_at = now() WHERE id = $1`, [
            roomId,
            matchId,
          ]);
          return { matchId, playerIds: members.map((m) => m.userId) };
        }
        return null;
      },
    );
    // Ya confirmada la partida, se avisa a los jugadores conectados por WebSocket.
    if (started !== null) await this.bus.matchAssigned(started.matchId, started.playerIds);
    return this.getAfterReady(roomId, userId);
  }

  /** Después de arrancar ya no hay miembros; el que marcó listo igual puede ver la sala y su partida. */
  private async getAfterReady(roomId: string, userId: string): Promise<Room> {
    const room = await this.load(this.deps.db, roomId);
    if (room === undefined) throw notFound('La sala');
    const members = await this.members(this.deps.db, roomId);
    return this.toRoom(room, members, members.some((m) => m.userId === userId) || room.status === 'started');
  }

  private async addMember(tx: Tx, roomId: string, userId: string): Promise<void> {
    await lockUser(tx, userId);
    await ensureAvailable(tx, userId);
    // El UPDATE condicionado es atómico: aunque se unan varios a la vez, nunca pasa de la capacidad.
    const { rowCount } = await tx.query(
      `UPDATE rooms SET member_count = member_count + 1, updated_at = now()
        WHERE id = $1 AND status = 'waiting' AND member_count < capacity`,
      [roomId],
    );
    if (rowCount !== 1) {
      const room = await this.load(tx, roomId);
      if (room === undefined) throw notFound('La sala');
      if (room.status !== 'waiting') throw conflict('ROOM_NOT_OPEN', 'La sala ya no está esperando jugadores');
      throw conflict('ROOM_FULL', 'La sala está llena');
    }
    await tx.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)', [roomId, userId]);
    // Unirse quita el «listo» de todos: la sala cambió y cada uno debe confirmar de nuevo.
    await tx.query('UPDATE room_members SET ready = false WHERE room_id = $1', [roomId]);
  }

  private async load(db: Pick<Db, 'query'>, roomId: string): Promise<RoomRow | undefined> {
    const { rows } = await db.query<RoomRow>('SELECT * FROM rooms WHERE id = $1', [roomId]);
    return rows[0];
  }

  private async lockRoom(tx: Tx, roomId: string): Promise<RoomRow | undefined> {
    const { rows } = await tx.query<RoomRow>('SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
    return rows[0];
  }

  private async members(db: Pick<Db, 'query'>, roomId: string): Promise<RoomMember[]> {
    const { rows } = await db.query<{ user_id: string; display_name: string; ready: boolean }>(
      `SELECT m.user_id, u.display_name, m.ready FROM room_members m JOIN users u ON u.id = m.user_id
        WHERE m.room_id = $1 ORDER BY m.joined_at, m.user_id`,
      [roomId],
    );
    return rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, ready: r.ready }));
  }

  private toRoom(row: RoomRow, members: RoomMember[], viewerIsMember: boolean): Room {
    return {
      id: row.id,
      visibility: row.visibility,
      inviteCode: viewerIsMember ? row.invite_code : null,
      capacity: row.capacity,
      status: row.status,
      hostId: row.host_id,
      members,
      matchId: row.match_id,
      createdAt: row.created_at.toISOString(),
    };
  }
}
