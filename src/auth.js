/**
 * Auth — JWT cookie httpOnly + bcrypt. Adaptado do core-blog-api.
 *
 * - Tabela: admin_users (id, email, name, role, password_hash, last_login_at)
 * - Cookie: COOKIE_NAME (default rivus_admin_session)
 * - Token TTL: TOKEN_TTL (default 30d)
 * - Anti-timing: bcrypt.compare sempre roda, mesmo em user inexistente.
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { one } from './db.js';

const JWT_SECRET = process.env.RIVUS_JWT_SECRET || process.env.JWT_SECRET;
const COOKIE_NAME = process.env.COOKIE_NAME || 'rivus_admin_session';
const TOKEN_TTL = process.env.TOKEN_TTL || '30d';
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';

// Hash bcrypt de "_dummy_dummy_" — usado pra manter timing uniforme em
// requests de email inexistente. Pré-computado pra evitar gerar a cada
// chamada.
const DUMMY_PASSWORD_HASH = '$2a$12$IU1tNkzYj/BgQ9FsBHt0/.AZC8gr3jaEBKQfk4JqBU.oFUCUCDKBO';

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('RIVUS_JWT_SECRET ausente ou curto (mínimo 32 chars). Setar no .env.');
}

/**
 * Valida email+senha contra admin_users. Retorna o row (sem o hash) se OK,
 * null caso contrário. bcrypt.compare roda mesmo em user inexistente pra
 * evitar enumeração de emails via timing.
 */
export async function verifyPassword(email, password) {
  const user = await one(
    `SELECT id, email, password_hash, name, role
     FROM admin_users
     WHERE LOWER(email) = $1
     LIMIT 1`,
    [String(email).trim().toLowerCase()],
  );
  const hash = user?.password_hash || DUMMY_PASSWORD_HASH;
  const ok = await bcrypt.compare(password || '', hash);
  if (!user || !ok) return null;
  // Audit fire-and-forget — não bloqueia login se update falhar.
  void one(`UPDATE admin_users SET last_login_at = NOW() WHERE id = $1 RETURNING id`, [user.id])
    .catch((err) => console.error('[auth audit error]', err.message));
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL },
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Middleware Express — extrai JWT do cookie OU Authorization Bearer,
 * valida, carrega req.user. Rejeita 401 se inválido.
 */
export function requireAuth(req, res, next) {
  (async () => {
    const fromHeader = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const fromCookie = req.cookies?.[COOKIE_NAME];
    const tokens = [fromHeader, fromCookie].filter(Boolean);
    if (tokens.length === 0) return res.status(401).json({ error: 'not_authenticated' });

    let claims = null;
    for (const token of tokens) {
      claims = verifyToken(token);
      if (claims?.sub) break;
    }
    if (!claims?.sub) return res.status(401).json({ error: 'invalid_token' });

    const user = await one(
      `SELECT id, email, name, role
       FROM admin_users
       WHERE id = $1
       LIMIT 1`,
      [claims.sub],
    );
    if (!user) return res.status(401).json({ error: 'invalid_token' });

    req.user = { sub: user.id, email: user.email, name: user.name, role: user.role };
    return next();
  })().catch(next);
}

export function requireRole(...allowedRoles) {
  const allowed = new Set(allowedRoles);
  return (req, res, next) => {
    if (!req.user?.role) return res.status(401).json({ error: 'not_authenticated' });
    if (!allowed.has(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    return next();
  };
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export const _constants = { COOKIE_NAME, TOKEN_TTL };
