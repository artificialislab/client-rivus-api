/**
 * /api/admin/stats — métricas operacionais do painel admin.
 *
 * Compõe um "health score" 0-100 da plataforma + números úteis pro
 * dashboard. Penalidades subtraem do 100 quando algo está fora do ideal:
 *   - DB latency > 100ms: -10 (alerta), > 500ms: -30 (degraded)
 *   - Admins lockados: -10 cada
 *   - Sem leads em 7d (e plataforma >7d): -5 (não bloqueia)
 *
 * Propósito: dar ao admin uma visão de "tudo OK" em 1 olhar (badge no
 * header). Click expande pra detalhes.
 */
import { Router } from 'express';
import { asyncHandler } from '../http.js';
import { requireAuth } from '../auth.js';
import { pool } from '../db.js';
import os from 'node:os';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (_req, res) => {
  // 1. DB ping com latência
  const t0 = Date.now();
  await pool.query('SELECT 1');
  const dbLatencyMs = Date.now() - t0;

  // 2. Agregações em uma query só (mais barato que múltiplas)
  const { rows: [agg] } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM early_access_leads WHERE deleted_at IS NULL)              AS total_leads,
      (SELECT COUNT(*)::int FROM early_access_leads WHERE deleted_at IS NULL
        AND created_at > NOW() - INTERVAL '24 hours')                                       AS leads_24h,
      (SELECT COUNT(*)::int FROM early_access_leads WHERE deleted_at IS NULL
        AND created_at > NOW() - INTERVAL '7 days')                                         AS leads_7d,
      (SELECT COUNT(*)::int FROM early_access_leads WHERE deleted_at IS NULL
        AND status = 'new')                                                                 AS leads_new,
      (SELECT COUNT(*)::int FROM early_access_leads WHERE deleted_at IS NOT NULL)           AS leads_deleted,
      (SELECT COUNT(*)::int FROM admin_users
        WHERE locked_until IS NOT NULL AND locked_until > NOW())                            AS admins_locked,
      (SELECT COUNT(*)::int FROM admin_users)                                               AS admins_total,
      (SELECT COALESCE(AVG(lead_score)::int, 0) FROM early_access_leads
        WHERE deleted_at IS NULL)                                                           AS avg_score,
      (SELECT MIN(created_at) FROM early_access_leads)                                      AS first_lead_at,
      (SELECT MAX(created_at) FROM early_access_leads WHERE deleted_at IS NULL)             AS last_lead_at
  `);

  // 3. Health score 0-100
  let health = 100;
  const penalties = [];
  if (dbLatencyMs > 500) {
    health -= 30; penalties.push({ kind: 'db_slow', detail: `latency=${dbLatencyMs}ms` });
  } else if (dbLatencyMs > 100) {
    health -= 10; penalties.push({ kind: 'db_slow_warn', detail: `latency=${dbLatencyMs}ms` });
  }
  if (agg.admins_locked > 0) {
    health -= 10 * agg.admins_locked;
    penalties.push({ kind: 'admin_locked', detail: `${agg.admins_locked} admin(s) lockado(s)` });
  }
  health = Math.max(0, health);

  res.json({
    healthScore: health,
    healthLabel: health >= 95 ? 'excelente' : health >= 80 ? 'bom' : health >= 60 ? 'atenção' : 'crítico',
    leads: {
      total: agg.total_leads,
      last24h: agg.leads_24h,
      last7d: agg.leads_7d,
      pending: agg.leads_new,
      deleted: agg.leads_deleted,
      avgScore: agg.avg_score,
      firstAt: agg.first_lead_at,
      lastAt: agg.last_lead_at,
    },
    admins: {
      total: agg.admins_total,
      locked: agg.admins_locked,
    },
    db: {
      latencyMs: dbLatencyMs,
      status: dbLatencyMs > 500 ? 'slow' : dbLatencyMs > 100 ? 'warn' : 'ok',
    },
    server: {
      uptimeS: Math.floor(process.uptime()),
      version: process.env.RIVUS_API_VERSION || 'dev',
      node: process.version,
      memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      hostname: os.hostname(),
    },
    penalties,
    fetchedAt: new Date().toISOString(),
  });
}));

export default router;
