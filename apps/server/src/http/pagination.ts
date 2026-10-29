import { AppError } from '../errors.js';

/** Cursor opaco para paginar por (fecha, id), del más nuevo al más viejo o al revés. */
export interface Cursor {
  readonly at: Date;
  readonly id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.at.toISOString(), cursor.id])).toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      const at = new Date(parsed[0]);
      if (!Number.isNaN(at.getTime()) && /^[0-9a-f-]{36}$/.test(parsed[1])) return { at, id: parsed[1] };
    }
  } catch {
    // cae al error de abajo
  }
  throw new AppError('validation-error', 'El cursor no es válido');
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

/** Con `limit + 1` filas pedidas, decide si hay otra página y arma su cursor. */
export function toPage<R, T>(
  rows: readonly R[],
  limit: number,
  map: (row: R) => T,
  cursorOf: (row: R) => Cursor,
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(map),
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last)) : null,
  };
}
