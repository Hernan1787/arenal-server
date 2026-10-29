import { createHash, randomBytes } from 'node:crypto';
import { exportPKCS8, generateKeyPair, importPKCS8, jwtVerify, SignJWT, type CryptoKey } from 'jose';
import type { Config } from '../config.js';

export type Role = 'player' | 'admin';

export interface AccessClaims {
  readonly userId: string;
  readonly role: Role;
}

const ALG = 'ES256';

export interface TokenIssuer {
  signAccess(claims: AccessClaims): Promise<string>;
  verifyAccess(token: string): Promise<AccessClaims>;
  readonly accessTtlSeconds: number;
}

export class InvalidTokenError extends Error {
  override readonly name = 'InvalidTokenError';
}

/**
 * Firma y verifica los access tokens (JWT ES256, de corta duración). La llave privada
 * viene de la configuración; fuera de producción, si no hay, se genera una temporal.
 */
export async function createTokenIssuer(
  config: Pick<Config, 'JWT_PRIVATE_KEY' | 'JWT_ISSUER' | 'JWT_AUDIENCE' | 'ACCESS_TOKEN_TTL_S' | 'NODE_ENV'>,
): Promise<TokenIssuer & { readonly ephemeralKey: boolean }> {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let ephemeralKey = false;

  if (config.JWT_PRIVATE_KEY === undefined) {
    if (config.NODE_ENV === 'production') throw new Error('Falta JWT_PRIVATE_KEY en producción');
    ({ privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true }));
    ephemeralKey = true;
  } else {
    const pem = config.JWT_PRIVATE_KEY.replace(/\\n/g, '\n');
    privateKey = await importPKCS8(pem, ALG, { extractable: true });
    publicKey = await derivePublicKey(privateKey);
  }

  return {
    ephemeralKey,
    accessTtlSeconds: config.ACCESS_TOKEN_TTL_S,
    signAccess: ({ userId, role }) =>
      new SignJWT({ role })
        .setProtectedHeader({ alg: ALG, typ: 'JWT' })
        .setSubject(userId)
        .setIssuer(config.JWT_ISSUER)
        .setAudience(config.JWT_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${config.ACCESS_TOKEN_TTL_S}s`)
        .sign(privateKey),
    verifyAccess: async (token) => {
      try {
        const { payload } = await jwtVerify(token, publicKey, {
          algorithms: [ALG],
          issuer: config.JWT_ISSUER,
          audience: config.JWT_AUDIENCE,
          clockTolerance: 5,
        });
        const role = payload['role'];
        if (typeof payload.sub !== 'string' || (role !== 'player' && role !== 'admin')) {
          throw new InvalidTokenError('Token con datos incompletos');
        }
        return { userId: payload.sub, role };
      } catch (error) {
        if (error instanceof InvalidTokenError) throw error;
        throw new InvalidTokenError('Token inválido o vencido');
      }
    },
  };
}

async function derivePublicKey(privateKey: CryptoKey): Promise<CryptoKey> {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  // La parte pública de una llave EC es (x, y); se quita `d`, que es la privada.
  const publicJwk = { ...jwk, ext: true };
  delete publicJwk.d;
  delete publicJwk.key_ops;
  return crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
}

/** Genera una llave ES256 nueva en PEM (para crear el secreto de Key Vault). */
export async function generatePrivateKeyPem(): Promise<string> {
  const { privateKey } = await generateKeyPair(ALG, { extractable: true });
  return exportPKCS8(privateKey);
}

/** Refresh token opaco: 32 bytes aleatorios. En la base solo se guarda su SHA-256. */
export function newRefreshToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
