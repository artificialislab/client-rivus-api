/**
 * /api/admin/leads — admin CRUD.
 *
 * Endpoints:
 *   GET    /                  — lista cursor-based + filtros
 *   GET    /export.csv        — CSV de tudo (mesmos filtros)
 *   GET    /:id               — detalhe + notes + status history
 *   PATCH  /:id               — patch parcial (status, tags, assignedTo, note)
 *   DELETE /:id               — soft delete
 *   POST   /:id/restore       — undo soft delete
 *   POST   /:id/notes         — adiciona nota interna
 *   GET    /:id/history       — status timeline (também vem em GET /:id)
 */
import { Router } from 'express';
import { asyncHandler } from '../http.js';
import { requireAuth } from '../auth.js';
import { validateBody, validateQuery, validateParams, UuidParamSchema } from '../middleware/validate.js';
import {
  LeadsListQuerySchema, LeadPatchSchema, NoteInputSchema,
} from '../schemas/leads.js';
import * as leadsService from '../services/leads.service.js';
import * as leadsRepo from '../repositories/leads.repository.js';

const router = Router();
router.use(requireAuth);

function ctxFromReq(req) {
  return {
    actorId: req.user?.sub,
    actorEmail: req.user?.email,
    requestId: req.id,
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  };
}

// ─── List ─────────────────────────────────────────────────────────────────
router.get('/', validateQuery(LeadsListQuerySchema), asyncHandler(async (req, res) => {
  const { tags: tagsCsv, ...rest } = req.query;
  const tags = tagsCsv ? tagsCsv.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const result = await leadsService.listLeads({ ...rest, tags });
  res.json(result);
}));

// ─── Export CSV ───────────────────────────────────────────────────────────
router.get('/export.csv', validateQuery(LeadsListQuerySchema), asyncHandler(async (req, res) => {
  const { tags: tagsCsv, ...rest } = req.query;
  const tags = tagsCsv ? tagsCsv.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  // Pra export, ignora cursor + limit (puxa tudo). Em produção real >10k
  // leads, vale streamar; por ora simples in-memory.
  const { items } = await leadsService.listLeads({ ...rest, tags, limit: 10000 });

  const headers = ['referencia', 'criado_em', 'status', 'score', 'perfil', 'volume',
                   'nome', 'email', 'empresa', 'telefone', 'origem', 'nota', 'tags',
                   'utm_source', 'utm_medium', 'utm_campaign', 'referrer'];
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of items) {
    lines.push([
      r.reference, (r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt),
      r.status, r.leadScore, r.profile, r.volumeBand,
      r.name, r.email, r.company, r.phone, r.origin || '', r.note || '',
      (r.tags || []).join('|'),
      r.utmSource || '', r.utmMedium || '', r.utmCampaign || '', r.referrer || '',
    ].map(escape).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="rivus-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n') + '\n');
}));

// ─── Detail ───────────────────────────────────────────────────────────────
router.get('/:id', validateParams(UuidParamSchema), asyncHandler(async (req, res) => {
  const lead = await leadsService.getLead(req.params.id);
  res.json(lead);
}));

// ─── Patch parcial ────────────────────────────────────────────────────────
router.patch('/:id',
  validateParams(UuidParamSchema),
  validateBody(LeadPatchSchema),
  asyncHandler(async (req, res) => {
    const updated = await leadsService.patchLead(req.params.id, req.body, ctxFromReq(req));
    res.json(updated);
  }),
);

// ─── Soft delete ──────────────────────────────────────────────────────────
router.delete('/:id', validateParams(UuidParamSchema), asyncHandler(async (req, res) => {
  const result = await leadsService.softDelete(req.params.id, ctxFromReq(req));
  res.json(result);
}));

// ─── Restore ──────────────────────────────────────────────────────────────
router.post('/:id/restore', validateParams(UuidParamSchema), asyncHandler(async (req, res) => {
  const result = await leadsService.restore(req.params.id, ctxFromReq(req));
  res.json(result);
}));

// ─── Notes ────────────────────────────────────────────────────────────────
router.post('/:id/notes',
  validateParams(UuidParamSchema),
  validateBody(NoteInputSchema),
  asyncHandler(async (req, res) => {
    const note = await leadsService.addNote(req.params.id, req.body.body, ctxFromReq(req));
    res.status(201).json({
      ...note,
      author: req.user.name || req.user.email,
    });
  }),
);

// ─── History (alias do que já vem em GET /:id) ────────────────────────────
router.get('/:id/history', validateParams(UuidParamSchema), asyncHandler(async (req, res) => {
  const history = await leadsRepo.getStatusHistory(req.params.id);
  res.json({ history });
}));

export default router;
