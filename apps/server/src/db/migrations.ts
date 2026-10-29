/**
 * Migraciones del esquema, en orden. Viven en TypeScript (y no en archivos .sql) para que
 * viajen dentro de la imagen sin pasos extra de copia. Una migración aplicada nunca se
 * edita: los cambios van en una migración nueva.
 */
export interface Migration {
  readonly id: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '001_inicial',
    sql: /* sql */ `
      CREATE TABLE users (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email         text NOT NULL UNIQUE,
        display_name  text NOT NULL,
        password_hash text NOT NULL,
        role          text NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
        suspended_at  timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now()
      );

      -- Refresh tokens: solo se guarda el hash. Todos los de una misma sesión comparten
      -- family_id; si alguien reusa uno ya rotado, se revoca la familia completa.
      CREATE TABLE refresh_tokens (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        family_id   uuid NOT NULL,
        token_hash  bytea NOT NULL UNIQUE,
        expires_at  timestamptz NOT NULL,
        used_at     timestamptz,
        revoked_at  timestamptz,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

      CREATE TABLE matches (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        origin          text NOT NULL CHECK (origin IN ('room', 'matchmaking')),
        status          text NOT NULL CHECK (status IN ('playing', 'finished', 'aborted')),
        -- Número de eventos aplicados; es el seq que ven los clientes.
        seq             integer NOT NULL DEFAULT 0,
        config          jsonb NOT NULL,
        -- Jugadores en el orden en que se creó la partida (entrada de createMatch).
        player_ids      uuid[] NOT NULL,
        current_player  uuid,
        turn            integer NOT NULL DEFAULT 0,
        turn_timeout_ms integer NOT NULL,
        turn_deadline   timestamptz,
        result          jsonb,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        finished_at     timestamptz
      );
      CREATE INDEX matches_turn_deadline_idx ON matches (turn_deadline) WHERE status = 'playing';

      CREATE TABLE match_players (
        match_id  uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
        user_id   uuid NOT NULL REFERENCES users (id),
        -- true mientras el jugador sigue en juego (no eliminado y partida sin terminar).
        active    boolean NOT NULL DEFAULT true,
        PRIMARY KEY (match_id, user_id)
      );
      -- Garantía dura: un jugador nunca está activo en dos partidas a la vez.
      CREATE UNIQUE INDEX match_players_one_active_idx ON match_players (user_id) WHERE active;
      CREATE INDEX match_players_user_idx ON match_players (user_id, match_id);

      -- Eventos de cada partida. Con el estado inicial reconstruyen la partida completa.
      CREATE TABLE match_events (
        match_id    uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
        seq         integer NOT NULL CHECK (seq > 0),
        event       jsonb NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (match_id, seq)
      );

      -- Registro de idempotencia: cada jugada del cliente trae un move_id propio.
      CREATE TABLE match_moves (
        match_id    uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
        move_id     uuid NOT NULL,
        user_id     uuid NOT NULL,
        seq_after   integer NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (match_id, move_id)
      );

      CREATE TABLE rooms (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id       uuid NOT NULL REFERENCES users (id),
        visibility    text NOT NULL CHECK (visibility IN ('public', 'private')),
        invite_code   text UNIQUE,
        capacity      smallint NOT NULL CHECK (capacity BETWEEN 2 AND 5),
        member_count  smallint NOT NULL DEFAULT 0 CHECK (member_count >= 0 AND member_count <= capacity),
        status        text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'started', 'closed')),
        match_id      uuid REFERENCES matches (id),
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        CHECK ((visibility = 'private') = (invite_code IS NOT NULL))
      );
      CREATE INDEX rooms_open_public_idx ON rooms (created_at, id) WHERE status = 'waiting' AND visibility = 'public';

      CREATE TABLE room_members (
        room_id    uuid NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
        user_id    uuid NOT NULL REFERENCES users (id),
        ready      boolean NOT NULL DEFAULT false,
        joined_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (room_id, user_id)
      );
      -- Un usuario está como máximo en una sala.
      CREATE UNIQUE INDEX room_members_one_room_idx ON room_members (user_id);

      CREATE TABLE matchmaking_tickets (
        user_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        status       text NOT NULL CHECK (status IN ('waiting', 'expired')),
        enqueued_at  timestamptz NOT NULL
      );
      CREATE INDEX matchmaking_waiting_idx ON matchmaking_tickets (enqueued_at) WHERE status = 'waiting';
    `,
  },
];
