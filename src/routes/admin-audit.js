/**
 * /api/admin/audit — leitura do audit_events.
 *
 * Cursor pagination + filtros (action, actorId, entityType, entityId).
 * Útil pra forensics, GDPR, debug.
 */
import { Router } from 'express';
import { asyncHandler } from '../http.js';
import { requireAuth } from '../auth.js';
import { validateQuery } from '../middleware/validate.js';
import { AuditQuerySchema } from '../schemas/leads.js';
import * as auditRepo from '../repositories/audit.repository.js';

const router = Router();
router.use(requireAuth);

router.get('/', validateQuery(AuditQuerySchema), asyncHandler(async (req, res) => {
  const result = await auditRepo.list(req.query);
  res.json(result);
}));

export default router;
