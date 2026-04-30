/**
 * Auth service — login com lockout + audit + bcrypt timing-safe.
 */
import bcrypt from 'bcryptjs';
import * as adminsRepo from '../repositories/admins.repository.js';
import * as audit from './audit.service.js';
import { signToken, setSessionCookie, clearSessionCookie } from '../auth.js';
import logger from '../logger.js';

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

// Hash de "_dummy_" pré-computado pra preservar timing uniforme em
// emails inexistentes (anti-enumeração).
const DUMMY_PASSWORD_HASH = '$2a$12$IU1tNkzYj/BgQ9FsBHt0/.AZC8gr3jaEBKQfk4JqBU.oFUCUCDKBO';

class AuthError extends Error {
  constructor(message, { status = 401, code = 'auth_error' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Valida credenciais. Lockout após N falhas. Retorna { user, token }.
 *
 * Erros:
 *   - 401 invalid_credentials (sem leak de qual campo)
 *   - 423 account_locked (com unlocksAt)
 */
export async function login({ email, password }, ctx = {}) {
  const user = await adminsRepo.findByEmail(email);
  // Mantém timing uniforme — bcrypt.compare sempre roda
  const hash = user?.password_hash || DUMMY_PASSWORD_HASH;
  const passwordOk = await bcrypt.compare(password || '', hash);

  // Caso 1: usuário não existe
  if (!user) {
    audit.record({
      requestId: ctx.requestId,
      action: 'admin.login_failed',
      changes: { reason: 'user_not_found', email },
      ip: ctx.ipAddress,
      userAgent: ctx.userAgent,
    }).catch(() => {});
    throw new AuthError('credenciais inválidas', { code: 'invalid_credentials' });
  }

  // Caso 2: locked (mesmo se senha correta — bloqueia)
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    audit.record({
      requestId: ctx.requestId,
      action: 'admin.login_blocked_locked',
      actorId: user.id, actorEmail: user.email,
      changes: { lockedUntil: user.lockedUntil },
      ip: ctx.ipAddress, userAgent: ctx.userAgent,
    }).catch(() => {});
    throw new AuthError('conta temporariamente bloqueada', {
      status: 423,
      code: 'account_locked',
    });
  }

  // Caso 3: senha errada (incrementa failed)
  if (!passwordOk) {
    const after = await adminsRepo.recordFailedLogin(user.id, {
      lockoutThreshold: LOCKOUT_THRESHOLD,
      lockoutMinutes: LOCKOUT_MINUTES,
    });
    audit.record({
      requestId: ctx.requestId,
      action: 'admin.login_failed',
      actorId: user.id, actorEmail: user.email,
      changes: { failedAttempts: after.failedAttempts, lockedUntil: after.lockedUntil },
      ip: ctx.ipAddress, userAgent: ctx.userAgent,
    }).catch(() => {});
    throw new AuthError('credenciais inválidas', { code: 'invalid_credentials' });
  }

  // Caso 4: sucesso — reset failed + audit + JWT
  await adminsRepo.recordSuccessfulLogin(user.id);
  const userPayload = { id: user.id, email: user.email, name: user.name, role: user.role };
  const token = signToken(userPayload);
  audit.record({
    requestId: ctx.requestId,
    action: 'admin.login_success',
    actorId: user.id, actorEmail: user.email,
    ip: ctx.ipAddress, userAgent: ctx.userAgent,
  }).catch(() => {});
  logger.info({ userId: user.id, email: user.email }, 'login_success');
  return { user: userPayload, token };
}

export async function logout(req, res) {
  clearSessionCookie(res);
  if (req.user) {
    audit.record({
      requestId: req.id,
      action: 'admin.logout',
      actorId: req.user.sub, actorEmail: req.user.email,
      ip: req.ip, userAgent: req.headers?.['user-agent'],
    }).catch(() => {});
  }
}

export { AuthError, setSessionCookie, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES };
