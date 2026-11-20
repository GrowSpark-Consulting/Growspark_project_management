/**
 * Audit log writer (table public.audit_log, append-only, superadmin-readable).
 * Failures never break the request being audited.
 */
import { logger } from '@/lib/debug-logger';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface AuditEntry {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  projectId?: string | null;
  details?: Record<string, unknown>;
}

export async function recordAudit(admin: any, e: AuditEntry): Promise<void> {
  try {
    const { error } = await admin.from('audit_log').insert({
      actor_id: e.actorId, action: e.action, entity_type: e.entityType,
      entity_id: e.entityId ?? null, project_id: e.projectId ?? null, details: e.details ?? {},
    });
    if (error) logger.warn('audit insert failed', { error: error.message });
  } catch (error) {
    logger.warn('audit failed', { error: (error as Error).message });
  }
}
