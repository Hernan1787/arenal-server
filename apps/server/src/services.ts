import type pg from 'pg';
import { AuthService } from './auth/auth-service.js';
import { createTokenIssuer } from './auth/tokens.js';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { ApiServices } from './http/routes.js';
import { MatchmakingService } from './lobby/matchmaking-service.js';
import { RoomsService } from './lobby/rooms-service.js';
import { MatchStore } from './matches/match-store.js';
import { MatchesService } from './matches/matches-service.js';
import { cryptoRng } from './rng.js';

export interface Services extends ApiServices {
  readonly store: MatchStore;
  readonly ephemeralJwtKey: boolean;
}

/** Arma los servicios de la aplicación con sus dependencias reales. */
export async function createServices(db: pg.Pool, config: Config, clock: Clock): Promise<Services> {
  const tokens = await createTokenIssuer(config);
  const store = new MatchStore({ db, clock, rng: cryptoRng, turnTimeoutMs: config.TURN_TIMEOUT_MS });
  return {
    tokens,
    store,
    ephemeralJwtKey: tokens.ephemeralKey,
    auth: new AuthService({ db, tokens, clock, refreshTtlSeconds: config.REFRESH_TOKEN_TTL_S }),
    rooms: new RoomsService({ db, store }),
    matches: new MatchesService({ db, store }),
    matchmaking: new MatchmakingService({
      db,
      store,
      clock,
      policy: {
        matchSize: config.MATCHMAKING_MATCH_SIZE,
        fillAfterMs: config.MATCHMAKING_FILL_AFTER_MS,
        maxWaitMs: config.MATCHMAKING_MAX_WAIT_MS,
      },
    }),
  };
}
