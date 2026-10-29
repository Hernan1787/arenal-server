import { randomInt } from 'node:crypto';
import type { Rng } from '@arenal/domain';

/** Azar criptográficamente seguro para el dominio: barajar el mazo y sortear el límite. */
export const cryptoRng: Rng = {
  int(min, max) {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new RangeError(`Rango inválido: ${min}..${max}`);
    }
    return randomInt(min, max + 1);
  },
};
