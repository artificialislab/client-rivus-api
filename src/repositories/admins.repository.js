/**
 * Repository — admin_users.
 *
 * Inclui suporte a lockout: failed_attempts + locked_until.
 */
import { one, q } from '../db.js';

export async function findByEmail(email) {
  return one(
    `SELECT id, email, password_hash, name, role,
            failed_attempts AS "failedAttempts",
            locked_until    AS "lockedUntil",
            last_failed_at  AS "lastFailedAt"
     FROM admin_users
     WHERE LOWER(email) = LOWER($1)
     LIMIT 1`,
    [email],
  );
}

export async function findById(id) {
  return one(
    `SELECT id, email, name, role,
            failed_attempts AS "failedAttempts",
            locked_until    AS "lockedUntil"
     FROM admin_users WHERE id = $1`,
    [id],
  );
}

export async function insert({ email, passwordHash, name, role = 'admin' }) {
  return one(
    `INSERT INTO admin_users (email, password_hash, name, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, name, role, created_at AS "createdAt"`,
    [email, passwordHash, name, role],
  );
}

export async function updatePassword(id, passwordHash) {
  return one(
    `UPDATE admin_users SET password_hash = $1 WHERE id = $2
     RETURNING id, email`,
    [passwordHash, id],
  );
}

export async function recordSuccessfulLogin(id) {
  await one(
    `UPDATE admin_users
        SET last_login_at = NOW(),
            failed_attempts = 0,
            locked_until = NULL
      WHERE id = $1
      RETURNING id`,
    [id],
  );
}

/**
 * Incrementa failed_attempts. Após `lockoutThreshold` falhas, seta
 * locked_until = NOW() + lockoutDuration. Idempotente em re-tentativas.
 *
 * Retorna { failedAttempts, lockedUntil }.
 */
export async function recordFailedLogin(id, { lockoutThreshold = 5, lockoutMinutes = 15 } = {}) {
  return one(
    `UPDATE admin_users
        SET failed_attempts = failed_attempts + 1,
            last_failed_at = NOW(),
            locked_until = CASE
              WHEN failed_attempts + 1 >= $2
              THEN NOW() + ($3 || ' minutes')::INTERVAL
              ELSE locked_until
            END
      WHERE id = $1
      RETURNING failed_attempts AS "failedAttempts",
                locked_until    AS "lockedUntil"`,
    [id, lockoutThreshold, String(lockoutMinutes)],
  );
}

export async function listAll() {
  return q(
    `SELECT id, email, name, role,
            last_login_at AS "lastLoginAt",
            failed_attempts AS "failedAttempts",
            locked_until AS "lockedUntil",
            created_at AS "createdAt"
     FROM admin_users ORDER BY created_at DESC`,
  );
}
