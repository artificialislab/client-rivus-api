/**
 * Rivus API — entry point.
 *
 * Boot Express + monta routers. Padrão idêntico ao core-blog-api:
 *   - JSON body parser limit 1mb
 *   - cookie-parser pra cookie httpOnly
 *   - cors com lista permissiva configurável (RIVUS_CORS_ORIGINS)
 *   - trust proxy (Caddy é o reverse proxy → 'loopback')
 *   - /health pro Docker healthcheck + Caddy upstream check
 *   - 404 + error handler genéricos no fim
 */
import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';

import earlyAccessRoutes from './routes/early-access.js';
import adminAuthRoutes from './routes/auth.js';
import adminLeadsRoutes from './routes/admin-leads.js';
import adminSeedRoutes from './routes/admin-seed.js';
import { pool } from './db.js';

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');

const ALLOWED_ORIGINS = (process.env.RIVUS_CORS_ORIGINS || 'http://localhost:8080')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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

// ─── Healthcheck — usado pelo Docker healthcheck e Caddy upstream ─────────
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      db: 'connected',
      version: process.env.RIVUS_API_VERSION || 'dev',
    });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'error', error: err.message });
  }
});

// ─── Rotas ─────────────────────────────────────────────────────────────────
// Caddy do tenant proxia /api/* pro container nessa porta (sem strip), então
// os paths começam com /api/. Compatível com o contrato que o Lovable já
// consome via leadsApi.
app.use('/api/early-access', earlyAccessRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/leads', adminLeadsRoutes);

// /admin/seed (sem /api/ prefix) — endpoint de provisioning chamado
// internamente pelo platform backend via docker exec, não pelo Caddy.
// Mantido fora do /api/ pra não vazar via reverse_proxy externo.
app.use('/admin/seed', adminSeedRoutes);

// 404 padrão
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.message === 'cors_blocked') {
    return res.status(403).json({ error: 'cors_blocked' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large' });
  }
  const status = Number(err.status || err.statusCode);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: 'bad_request' });
  }
  // eslint-disable-next-line no-console
  console.error('[api error]', err.stack || err.message);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`[rivus-api] listening on :${PORT}  version=${process.env.RIVUS_API_VERSION || 'dev'}`);
});
