/**
 * Línea de comandos para operar el servidor. Es la única forma de dar o quitar el rol de
 * administrador; queda en la auditoría con actor `null` (operador).
 *
 *   node dist/cli/admin.js grant  <correo> --reason "<motivo>"
 *   node dist/cli/admin.js revoke <correo> --reason "<motivo>"
 *
 * Se conecta a Postgres con las mismas variables que el servidor (PG_HOST, PG_USER…). En
 * Azure se corre dentro del contenedor con `az containerapp exec`.
 */
import { parseArgs } from 'node:util';
import { setUserRole } from '../admin/roles.js';
import { loadConfig } from '../config.js';
import { AppError } from '../errors.js';
import { createPostgresPool } from '../infra/postgres.js';

const USAGE = 'Uso: admin <grant|revoke> <correo> --reason "<motivo de 3 a 500 caracteres>"';

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { reason: { type: 'string' } },
  });
  const [command, email, ...rest] = positionals;
  const reason = values.reason?.trim() ?? '';
  if ((command !== 'grant' && command !== 'revoke') || email === undefined || rest.length > 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (reason.length < 3 || reason.length > 500) {
    process.stderr.write(`El motivo debe tener entre 3 y 500 caracteres.\n${USAGE}\n`);
    return 2;
  }

  const pool = createPostgresPool(loadConfig());
  try {
    const role = command === 'grant' ? 'admin' : 'player';
    const { userId, changed } = await setUserRole(pool, email, role, { actorId: null, reason, requestId: null });
    process.stdout.write(
      changed ? `Listo: ${userId} ahora tiene el rol ${role}.\n` : `Sin cambios: ${userId} ya tenía el rol ${role}.\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof AppError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
