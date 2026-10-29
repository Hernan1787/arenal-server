/**
 * Puerto de azar. El dominio nunca genera números aleatorios por su cuenta:
 * en producción el servidor inyecta una implementación con `crypto.randomInt`,
 * y en las pruebas una con semilla para que sean reproducibles.
 */
export interface Rng {
  /** Entero uniforme entre `min` y `max`, ambos inclusive. */
  int(min: number, max: number): number;
}

/** Fisher–Yates: devuelve una copia barajada sin modificar la original. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const a = result[i] as T;
    const b = result[j] as T;
    result[i] = b;
    result[j] = a;
  }
  return result;
}
