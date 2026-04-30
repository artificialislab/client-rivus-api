/**
 * Repository — idempotency_keys.
 *
 * Padrão Stripe-style: cliente envia `Idempotency-Key: <uuid>` em POST.
 * Se já existe, retorna a mesma response sem re-executar.
 * TTL 24h. Cleanup de expirados em chamada lazy.
 */
import { one } from '../db.js';

/**
 * Tenta resolver idempotency. Retorna a response gravada anteriormente
 * (se key existe e não expirou), ou null pra prosseguir com a operação.
 */
export async function resolve(key, endpoint) {
  if (!key) return null;
  return one(
    `SELECT response_status AS "responseStatus", response_body AS "responseBody"
     FROM idempotency_keys
     WHERE key = $1 AND endpoint = $2 AND expires_at > NOW()
     LIMIT 1`,
    [key, endpoint],
  );
}

/**
 * Grava response pra dedup futuro. Idempotente em re-tentativa do mesmo
 * key — ON CONFLICT DO NOTHING garante que segunda chamada não sobrescreve.
 */
export async function record(key, endpoint, status, body) {
  if (!key) return null;
  return one(
    `INSERT INTO idempotency_keys (key, endpoint, response_status, response_body)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, endpoint, status, JSON.stringify(body)],
  );
}

/** Cleanup lazy — chamado de tempos em tempos pela seed/migrate. */
export async function cleanupExpired() {
  return one(
    `DELETE FROM idempotency_keys WHERE expires_at < NOW() RETURNING 1`,
  );
}
