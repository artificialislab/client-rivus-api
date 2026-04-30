/**
 * /api/admin/leads — CRUD do painel admin.
 *
 * Implementa LeadsApi#list / get / updateStatus / addNote / exportCsv que
 * o front Lovable já consome via stub. Auth via requireAuth (cookie httpOnly).
 */
import { Router } from 'express';
import { q, one, pool } from '../db.js';
import { asyncHandler } from '../http.js';
import { requireAuth } from '../auth.js';

const router = Router();

const VALID_STATUSES = new Set(['new', 'contacted', 'qualified', 'rejected', 'converted']);
const VALID_PROFILES = new Set(['buyer', 'seller', 'both']);
const VALID_BANDS = new Set(['lt_500k', '500k_2m', '2m_10m', '10m_50m', 'gt_50m']);

router.use(requireAuth);

/**
 * GET /api/admin/leads
 * Query params: search, status, profile, volumeBand, sort=newest|oldest, page, pageSize
 */
router.get('/', asyncHandler(async (req, res) => {
  const search = (req.query.search || '').toString().trim().toLowerCase();
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null;
  const profile = req.query.profile && req.query.profile !== 'all' ? req.query.profile : null;
  const volumeBand = req.query.volumeBand && req.query.volumeBand !== 'all' ? req.query.volumeBand : null;
  const sort = req.query.sort === 'oldest' ? 'ASC' : 'DESC';
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 25));

  if (status && !VALID_STATUSES.has(status)) return res.status(400).json({ error: 'invalid_status' });
  if (profile && !VALID_PROFILES.has(profile)) return res.status(400).json({ error: 'invalid_profile' });
  if (volumeBand && !VALID_BANDS.has(volumeBand)) return res.status(400).json({ error: 'invalid_volume_band' });

  // WHERE dinâmico
  const where = [];
  const params = [];
  let p = 1;
  if (status)     { where.push(`status = $${p++}`);                          params.push(status); }
  if (profile)    { where.push(`profile = $${p++}`);                         params.push(profile); }
  if (volumeBand) { where.push(`volume_band = $${p++}`);                     params.push(volumeBand); }
  if (search) {
    where.push(`(LOWER(name) LIKE $${p} OR LOWER(email) LIKE $${p} OR LOWER(company) LIKE $${p})`);
    params.push(`%${search}%`);
    p++;
  }
  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Total
  const totalRow = await one(`SELECT COUNT(*)::int AS c FROM early_access_leads ${whereSQL}`, params);
  const total = totalRow?.c || 0;

  // Page
  const offset = (page - 1) * pageSize;
  const items = await q(
    `SELECT id, reference, name, email, company, phone, profile, volume_band AS "volumeBand",
            origin, note, status,
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM early_access_leads
     ${whereSQL}
     ORDER BY created_at ${sort}
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  res.json({ items, total, page, pageSize });
}));

/**
 * GET /api/admin/leads/export.csv
 * Mesmos filtros, retorna CSV completo (sem paginação).
 */
router.get('/export.csv', asyncHandler(async (req, res) => {
  const search = (req.query.search || '').toString().trim().toLowerCase();
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null;
  const profile = req.query.profile && req.query.profile !== 'all' ? req.query.profile : null;
  const volumeBand = req.query.volumeBand && req.query.volumeBand !== 'all' ? req.query.volumeBand : null;
  const sort = req.query.sort === 'oldest' ? 'ASC' : 'DESC';

  const where = [];
  const params = [];
  let p = 1;
  if (status)     { where.push(`status = $${p++}`);                          params.push(status); }
  if (profile)    { where.push(`profile = $${p++}`);                         params.push(profile); }
  if (volumeBand) { where.push(`volume_band = $${p++}`);                     params.push(volumeBand); }
  if (search) {
    where.push(`(LOWER(name) LIKE $${p} OR LOWER(email) LIKE $${p} OR LOWER(company) LIKE $${p})`);
    params.push(`%${search}%`); p++;
  }
  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await q(
    `SELECT reference, created_at, status, profile, volume_band, name, email, company, phone, origin, note
     FROM early_access_leads ${whereSQL} ORDER BY created_at ${sort}`,
    params,
  );

  const headers = ['referencia', 'criado_em', 'status', 'perfil', 'volume', 'nome', 'email', 'empresa', 'telefone', 'origem', 'nota'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const vals = [
      r.reference,
      r.created_at?.toISOString?.() || r.created_at,
      r.status,
      r.profile,
      r.volume_band,
      r.name,
      r.email,
      r.company,
      r.phone,
      r.origin || '',
      r.note || '',
    ].map((v) => {
      const s = String(v ?? '');
      // Escape CSV: aspas internas dobradas, envelopa em aspas se tem vírgula/aspas/quebra
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    });
    lines.push(vals.join(','));
  }
  const csv = lines.join('\n') + '\n';

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="rivus-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

/**
 * GET /api/admin/leads/:id — detail incluindo internalNotes.
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const lead = await one(
    `SELECT id, reference, name, email, company, phone, profile,
            volume_band AS "volumeBand", origin, note, status,
            ip_address::text AS "ipAddress", user_agent AS "userAgent",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM early_access_leads WHERE id = $1`,
    [req.params.id],
  );
  if (!lead) return res.status(404).json({ error: 'lead_not_found' });

  const notes = await q(
    `SELECT n.id, n.body, n.created_at AS "createdAt",
            COALESCE(u.name, u.email, '(removido)') AS author,
            n.author_id AS "authorId"
     FROM lead_notes n
     LEFT JOIN admin_users u ON u.id = n.author_id
     WHERE n.lead_id = $1
     ORDER BY n.created_at DESC`,
    [req.params.id],
  );

  res.json({ ...lead, internalNotes: notes });
}));

/**
 * PATCH /api/admin/leads/:id/status — body { status }
 */
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: 'invalid_status' });

  const updated = await one(
    `UPDATE early_access_leads SET status = $1 WHERE id = $2
     RETURNING id, reference, status, updated_at AS "updatedAt"`,
    [status, req.params.id],
  );
  if (!updated) return res.status(404).json({ error: 'lead_not_found' });
  res.json(updated);
}));

/**
 * POST /api/admin/leads/:id/notes — body { body }
 */
router.post('/:id/notes', asyncHandler(async (req, res) => {
  const body = (req.body?.body || '').toString().trim();
  if (!body) return res.status(400).json({ error: 'body_required' });
  if (body.length > 2000) return res.status(400).json({ error: 'body_too_long' });

  const lead = await one(`SELECT id FROM early_access_leads WHERE id = $1`, [req.params.id]);
  if (!lead) return res.status(404).json({ error: 'lead_not_found' });

  const note = await one(
    `INSERT INTO lead_notes (lead_id, author_id, body)
     VALUES ($1, $2, $3)
     RETURNING id, body, created_at AS "createdAt"`,
    [req.params.id, req.user.sub, body],
  );

  res.status(201).json({
    ...note,
    author: req.user.name || req.user.email,
    authorId: req.user.sub,
  });
}));

export default router;

// Re-export pool pra cleanup em testes.
export { pool };
