import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id (el algoritmo por defecto de la librería) con los parámetros mínimos que
 * recomienda OWASP: 19 MiB de memoria, 2 iteraciones, 1 hilo.
 */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Cuando el correo no existe igual se verifica contra un hash de relleno, para que el
 * tiempo de respuesta no revele qué correos están registrados.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('relleno-para-igualar-tiempos');
  await verifyPassword(await dummyHash, password);
  return false;
}
