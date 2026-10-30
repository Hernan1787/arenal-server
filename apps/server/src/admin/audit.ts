import type { Db } from '../db/tx.js';

export type AuditAction =
  'match.terminate' | 'user.suspend' | 'user.reinstate' | 'user.grant_admin' | 'user.revoke_admin';
export type AuditTarget = 'match' | 'user';

/** Quién hace la acción y por qué. Viaja desde la ruta hasta la fila de auditoría. */
export interface AuditContext {
  /** `null` cuando la acción viene de la línea de comandos (no hay usuario). */
  readonly actorId: string | null;
  readonly reason: string;
  /** ID de la solicitud HTTP, para cruzar la auditoría con los logs. */
  readonly requestId: string | null;
}

export interface AuditRecord {
  readonly action: AuditAction;
  readonly targetType: AuditTarget;
  readonly targetId: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Escribe la fila de auditoría. Siempre se llama dentro de la transacción de la acción: si
 * la auditoría falla, la acción tampoco queda. La tabla no admite cambios ni borrados.
 */
export async function writeAudit(tx: Pick<Db, 'query'>, record: AuditRecord, ctx: AuditContext): Promise<void> {
  await tx.query(
    `INSERT INTO admin_audit (actor_id, action, target_type, target_id, reason, details, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      ctx.actorId,
      record.action,
      record.targetType,
      record.targetId,
      ctx.reason,
      JSON.stringify(record.details ?? {}),
      ctx.requestId,
    ],
  );
}
