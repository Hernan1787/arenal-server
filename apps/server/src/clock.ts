/** Reloj del servidor. Se inyecta para que las pruebas controlen el tiempo. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
