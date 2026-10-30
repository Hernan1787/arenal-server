import type { Role } from '../auth/tokens.js';
import { normalizeEmail } from '../auth/auth-service.js';
import { withTransaction, type Db } from '../db/tx.js';
import { notFound } from '../errors.js';
import { writeAudit, type AuditContext } from './audit.js';

/**
 * Da o quita el rol de administrador, con su fila de auditoría. Solo se usa desde la línea de
 * comandos (`src/cli/admin.ts`): por la API nadie puede darse permisos. El cambio aplica en la
 * siguiente solicitud, porque la guardia lee el rol de la base. Devuelve `changed: false` si el
 * usuario ya tenía ese rol.
 */
export async function setUserRole(
  db: Db,
  email: string,
  role: Role,
  ctx: AuditContext,
): Promise<{ userId: string; changed: boolean }> {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ id: string; role: Role }>(
      'SELECT id, role FROM users WHERE email = $1 FOR NO KEY UPDATE',
      [normalizeEmail(email)],
    );
    const user = rows[0];
    if (user === undefined) throw notFound('El usuario');
    if (user.role === role) return { userId: user.id, changed: false };
    await tx.query('UPDATE users SET role = $2 WHERE id = $1', [user.id, role]);
    await writeAudit(
      tx,
      {
        action: role === 'admin' ? 'user.grant_admin' : 'user.revoke_admin',
        targetType: 'user',
        targetId: user.id,
        details: { previousRole: user.role },
      },
      ctx,
    );
    return { userId: user.id, changed: true };
  });
}
