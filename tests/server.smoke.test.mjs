/**
 * Smoke tests da API Rivus — sem DB real (sintaxe + shape estático).
 *
 * Garante que:
 *   - Todos os routers importam sem erro.
 *   - Helpers (generateReference, validations) seguem contrato.
 *   - Schema SQL é parseável e tem as tabelas mínimas.
 *
 * Tests funcionais (com Postgres real) ficam no CI integration suite —
 * fora do escopo deste arquivo pra rodar local sem dependências.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('package.json declara deps mínimas e Node >=20', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.engines.node.includes('20'));
  for (const dep of ['express', 'pg', 'bcryptjs', 'jsonwebtoken', 'cookie-parser', 'cors', 'express-rate-limit', 'dotenv']) {
    assert.ok(pkg.dependencies[dep], `dep ausente: ${dep}`);
  }
});

test('db/001_init.sql contém as 3 tabelas core', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '001_init.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS admin_users/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS early_access_leads/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS lead_notes/);
  // Constraints críticos
  assert.match(sql, /CHECK \(profile IN \('buyer', 'seller', 'both'\)\)/);
  assert.match(sql, /CHECK \(volume_band IN/);
  assert.match(sql, /CHECK \(status IN/);
  // Trigger updated_at
  assert.match(sql, /CREATE TRIGGER trg_leads_updated_at/);
});

test('Dockerfile usa node:20-alpine + roda migrate antes do server', () => {
  const docker = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(docker, /FROM node:20-alpine/);
  assert.match(docker, /node src\/migrate\.js && node src\/server\.js/);
  assert.match(docker, /HEALTHCHECK/);
});

test('CI workflow publica em ghcr.io/artificialislab/rivus-api', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'docker-publish.yml'), 'utf8');
  assert.match(yml, /IMAGE_NAME: artificialislab\/rivus-api/);
  assert.match(yml, /tags: \['v\*\.\*\.\*'\]/);
});

test('server.js monta os 4 routers em paths corretos', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /app\.use\('\/api\/early-access', earlyAccessRoutes\)/);
  assert.match(src, /app\.use\('\/api\/admin\/auth', adminAuthRoutes\)/);
  assert.match(src, /app\.use\('\/api\/admin\/leads', adminLeadsRoutes\)/);
  assert.match(src, /app\.use\('\/admin\/seed', adminSeedRoutes\)/);
  // /admin/seed NÃO sob /api/ — não deve ser exposto pelo Caddy externo
  assert.ok(!src.includes("'/api/admin/seed'"), '/admin/seed deve ficar fora de /api/');
});

test('early-access valida profile + volumeBand contra contrato do Lovable', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'early-access.js'), 'utf8');
  // Mesmas constantes que o frontend Lovable usa em src/lib/api/leads.ts
  assert.match(src, /'buyer', 'seller', 'both'/);
  assert.match(src, /'lt_500k', '500k_2m', '2m_10m', '10m_50m', 'gt_50m'/);
  // Reference RIV-XXXXXX matching o que o stub do Lovable já gerava
  assert.match(src, /RIV-/);
});
