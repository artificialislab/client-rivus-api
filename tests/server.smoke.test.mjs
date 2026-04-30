/**
 * Smoke tests da API Rivus — sem DB real (sintaxe + shape estático).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

test('package.json declara deps + Node >=20', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.engines.node.includes('20'));
  for (const dep of ['express', 'pg', 'bcryptjs', 'jsonwebtoken', 'cookie-parser', 'cors',
                     'express-rate-limit', 'dotenv', 'zod', 'pino']) {
    assert.ok(pkg.dependencies[dep], `dep ausente: ${dep}`);
  }
});

test('db migrations: 001_init + 002_robustness', () => {
  const init = read('db/001_init.sql');
  assert.match(init, /CREATE TABLE IF NOT EXISTS admin_users/);
  assert.match(init, /CREATE TABLE IF NOT EXISTS early_access_leads/);
  assert.match(init, /CREATE TABLE IF NOT EXISTS lead_notes/);

  const robust = read('db/002_robustness.sql');
  assert.match(robust, /ALTER TABLE early_access_leads ADD COLUMN IF NOT EXISTS deleted_at/);
  assert.match(robust, /ALTER TABLE early_access_leads ADD COLUMN IF NOT EXISTS tags/);
  assert.match(robust, /CREATE TABLE IF NOT EXISTS lead_status_history/);
  assert.match(robust, /CREATE TABLE IF NOT EXISTS audit_events/);
  assert.match(robust, /CREATE TABLE IF NOT EXISTS idempotency_keys/);
  assert.match(robust, /CREATE OR REPLACE FUNCTION compute_lead_score/);
  assert.match(robust, /CREATE TRIGGER trg_leads_status_history/);
  assert.match(robust, /CREATE TRIGGER trg_leads_set_score/);
  // Lockout em admin_users
  assert.match(robust, /failed_attempts/);
  assert.match(robust, /locked_until/);
});

test('Dockerfile: Node 20 alpine, migrate antes do server, healthcheck', () => {
  const docker = read('Dockerfile');
  assert.match(docker, /FROM node:20-alpine/);
  assert.match(docker, /node src\/migrate\.js && node src\/server\.js/);
  assert.match(docker, /HEALTHCHECK/);
});

test('CI workflow publica em ghcr.io/artificialislab/rivus-api', () => {
  const yml = read('.github/workflows/docker-publish.yml');
  assert.match(yml, /IMAGE_NAME: artificialislab\/rivus-api/);
  assert.match(yml, /tags: \['v\*\.\*\.\*'\]/);
});

test('server.js monta os routers corretos + health/ready', () => {
  const src = read('src/server.js');
  assert.match(src, /app\.use\('\/api\/early-access', earlyAccessRoutes\)/);
  assert.match(src, /app\.use\('\/api\/admin\/auth', adminAuthRoutes\)/);
  assert.match(src, /app\.use\('\/api\/admin\/leads', adminLeadsRoutes\)/);
  assert.match(src, /app\.use\('\/api\/admin\/audit', adminAuditRoutes\)/);
  assert.match(src, /app\.use\('\/admin\/seed', adminSeedRoutes\)/);
  assert.ok(!src.includes("'/api/admin/seed'"), '/admin/seed deve ficar fora de /api/');
  // Liveness + readiness
  assert.match(src, /app\.get\('\/health'/);
  assert.match(src, /app\.get\('\/ready'/);
  // Graceful shutdown
  assert.match(src, /process\.on\('SIGTERM'/);
});

test('Routes thin: usam validate + service (sem regra inline)', () => {
  const ea = read('src/routes/early-access.js');
  assert.match(ea, /validateBody\(LeadInputSchema\)/);
  assert.match(ea, /idempotencyMiddleware/);
  assert.match(ea, /leadsService\.createLead/);

  const al = read('src/routes/admin-leads.js');
  assert.match(al, /validateQuery\(LeadsListQuerySchema\)/);
  assert.match(al, /validateBody\(LeadPatchSchema\)/);
  assert.match(al, /leadsService\.patchLead/);
  assert.match(al, /leadsService\.softDelete/);
  assert.match(al, /leadsService\.restore/);
  assert.match(al, /leadsService\.addNote/);

  const auth = read('src/routes/auth.js');
  assert.match(auth, /authService\.login/);
});

test('Camadas presentes: schemas + repositories + services + middleware', () => {
  for (const file of [
    'src/schemas/leads.js',
    'src/schemas/auth.js',
    'src/repositories/leads.repository.js',
    'src/repositories/notes.repository.js',
    'src/repositories/admins.repository.js',
    'src/repositories/audit.repository.js',
    'src/repositories/idempotency.repository.js',
    'src/services/leads.service.js',
    'src/services/auth.service.js',
    'src/services/audit.service.js',
    'src/services/scoring.service.js',
    'src/middleware/requestId.js',
    'src/middleware/validate.js',
    'src/middleware/idempotency.js',
    'src/middleware/errorHandler.js',
    'src/logger.js',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `arquivo ausente: ${file}`);
  }
});
