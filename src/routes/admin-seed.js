/**
 * /admin/seed — provisioning endpoint chamado pelo platform backend
 * durante o install do serviço rivus-api. Cria a conta admin inicial.
 *
 * Idempotente-safe: se já existe conta com esse email, retorna 409 sem
 * tocar no password_hash. Protege contra reinstalação acidental resetar
 * senha do cliente.
 *
 * Auth via header X-Seed-Token (= RIVUS_SEED_TOKEN env). Usa
 * timingSafeEqual pra evitar leak via timing attack.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { one } from '../db.js';
import { hashPassword } from '../auth.js';
import { asyncHandler } from '../http.js';
import { seedRateLimit } from '../rateLimit.js';

const router = Router();

const SEED_TOKEN = process.env.RIVUS_SEED_TOKEN || process.env.SEED_TOKEN || '';

function generateStrongPassword(len = 20) {
  // 20 chars base64url ≈ 120 bits de entropia.
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

function isSeedTokenValid(presented) {
  if (!SEED_TOKEN || SEED_TOKEN.length < 32) return false;

  const expectedBuffer = Buffer.from(SEED_TOKEN);
  const presentedBuffer = Buffer.from(String(presented || ''));
  return expectedBuffer.length === presentedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, presentedBuffer);
}

router.post('/', seedRateLimit, asyncHandler(async (req, res) => {
  if (!SEED_TOKEN || SEED_TOKEN.length < 32) {
    return res.status(503).json({ error: 'seed_not_configured' });
  }
  const presented = (req.headers['x-seed-token'] || '').toString();
  if (!isSeedTokenValid(presented)) {
    return res.status(401).json({ error: 'invalid_seed_token' });
  }

  const { email, name } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const displayName = String(name || '').trim() || normalizedEmail.split('@')[0];

  const existing = await one(
    `SELECT id, email, created_at FROM admin_users WHERE LOWER(email) = $1 LIMIT 1`,
    [normalizedEmail],
  );
  if (existing) {
    return res.status(409).json({
      error: 'user_already_exists',
      message: 'Conta já existe. Use o CLI de reset: docker compose exec rivus-api node src/seed-admin.js <email> <senha>',
      user: { id: existing.id, email: existing.email, created_at: existing.created_at },
    });
  }

  const plainPassword = generateStrongPassword();
  const hash = await hashPassword(plainPassword);

  const user = await one(
    `INSERT INTO admin_users (email, password_hash, name, role)
     VALUES ($1, $2, $3, 'admin')
     RETURNING id, email, name, role, created_at`,
    [normalizedEmail, hash, displayName],
  );

  res.status(201).json({
    user,
    password: plainPassword,
    warning: 'Guarde essa senha agora — não será exibida novamente. Reset via: docker compose exec rivus-api node src/seed-admin.js <email> <senha>',
  });
}));

export default router;
