/**
 * Audit service — wrapper sobre o repository com helpers de conveniência.
 *
 * Resiliente: falha no audit NUNCA derruba a operação principal — log
 * warn + segue. Audit é "best effort" mas projetado pra não perder eventos
 * em condições normais.
 */
import * as auditRepo from '../repositories/audit.repository.js';
import logger from '../logger.js';

export async function record(event) {
  try {
    return await auditRepo.record(event);
  } catch (err) {
    logger.warn({ err: err.message, event }, 'audit_record_failed');
    return null;
  }
}

/** Conveniência — extrai contexto do request. */
export function fromReq(req, { action, entityType, entityId, changes } = {}) {
  return {
    requestId: req.id || req.requestId || null,
    action,
    actorId: req.user?.sub || null,
    actorEmail: req.user?.email || null,
    entityType,
    entityId,
    changes,
    ip: req.ip || req.headers?.['x-real-ip'] || null,
    userAgent: (req.headers?.['user-agent'] || '').slice(0, 500),
  };
}

export async function recordFromReq(req, payload) {
  return record(fromReq(req, payload));
}
