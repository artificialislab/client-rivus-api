/**
 * Rivus API — entry point.
 *
 * Boot Express + monta middleware + routes. Pipeline:
 *   1. requestId (UUID por request, header X-Request-ID)
 *   2. cors + json + cookie-parser
 *   3. trust proxy = loopback (Caddy é o reverse proxy)
 *   4. routes públicas: /api/early-access (rate-limited, idempotency)
 *   5. routes admin (cookie httpOnly): /api/admin/auth /leads /audit
 *   6. /admin/seed (interno, sem prefix /api/ — não exposto pelo Caddy)
 *   7. /health (liveness, sempre 200) + /ready (readiness, valida DB)
 *   8. errorHandler centralizado + 404
 *   9. graceful shutdown (SIGTERM/SIGINT)
 */
import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';

import logger from './logger.js';
import { pool } from './db.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

import earlyAccessRoutes from './routes/early-access.js';
import adminAuthRoutes from './routes/auth.js';
import adminLeadsRoutes from './routes/admin-leads.js';
import adminAuditRoutes from './routes/admin-audit.js';
import adminStatsRoutes from './routes/admin-stats.js';
import adminSeedRoutes from './routes/admin-seed.js';

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.disable('x-powered-by');

// Request ID antes de TUDO pra logs sempre terem.
app.use(requestIdMiddleware);

const ALLOWED_ORIGINS = (process.env.RIVUS_CORS_ORIGINS || 'http://localhost:8080')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('cors_blocked'), false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ─── Liveness — sempre 200 enquanto processo respira ──────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: process.env.RIVUS_API_VERSION || 'dev' });
});

// ─── Readiness — valida DB + migrations ─────────────────────────────────
app.get('/ready', async (_req, res) => {
  try {
    // 1. Pool responde
    await pool.query('SELECT 1');
    // 2. Tabelas core existem (proxy pra "migrations rodaram")
    const { rows } = await pool.query(`
      SELECT to_regclass('public.early_access_leads') AS leads,
             to_regclass('public.admin_users') AS admins,
             to_regclass('public.audit_events') AS audit
    `);
    const ok = rows[0].leads && rows[0].admins && rows[0].audit;
    if (!ok) {
      return res.status(503).json({ status: 'not_ready', reason: 'missing_tables', detail: rows[0] });
    }
    res.json({
      status: 'ready',
      db: 'connected',
      tables: { leads: !!rows[0].leads, admins: !!rows[0].admins, audit: !!rows[0].audit },
      version: process.env.RIVUS_API_VERSION || 'dev',
    });
  } catch (err) {
    res.status(503).json({ status: 'not_ready', reason: 'db_error', message: err.message });
  }
});

// ─── Routes ─────────────────────────────────────────────────────────────
// Públicas (sem auth)
app.use('/api/early-access', earlyAccessRoutes);

// Admin (cookie httpOnly via requireAuth dentro de cada router)
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/leads', adminLeadsRoutes);
app.use('/api/admin/audit', adminAuditRoutes);
app.use('/api/admin/stats', adminStatsRoutes);

// Provisioning interno — fora de /api/ (não exposto pelo Caddy externo)
app.use('/admin/seed', adminSeedRoutes);

// 404 + error handler centralizado
app.use(notFoundHandler);
app.use(errorHandler);

// ─── Boot + graceful shutdown ───────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT }, 'rivus_api_listening');
});

function shutdown(signal) {
  logger.info({ signal }, 'rivus_api_shutting_down');
  server.close(() => {
    pool.end().then(() => {
      logger.info('rivus_api_shutdown_complete');
      process.exit(0);
    }).catch((err) => {
      logger.error({ err: err.message }, 'pool_end_failed');
      process.exit(1);
    });
  });
  // Force exit after 10s se shutdown travar
  setTimeout(() => {
    logger.warn('shutdown_force_exit');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'unhandled_rejection');
});
