/**
 * Repository — idempotency_keys (claim-first).
 *
 * Padrão Stripe-style: cliente envia `Idempotency-Key: <uuid>` em POST.
 * O middleware faz um CLAIM atômico (INSERT ... ON CONFLICT) ANTES de
 * processar; a response é preenchida DEPOIS via UPDATE. Linha sem response
 * = request em andamento. Isso fecha a corrida do padrão antigo
 * resolve()/record(), em que dois POSTs simultâneos com a mesma key
 * processavam duas vezes.
 *
 * TTL 24h; linha expirada pode ser re-claimada. Cleanup de expirados no
 * migrate.js, que roda a cada boot do container (CMD do Dockerfile).
 */
import { one } from '../db.js';

/**
 * Claim atômico da key. Retorna row se ESTA request ganhou o claim
 * (insert novo ou reclaim de linha expirada); null se a key já está ativa
 * — nesse caso usar find() pra decidir entre replay, 409 ou seguir.
 */
export async function claim(key, endpoint) {
  if (!key) return null;
  return one(
    `INSERT INTO idempotency_keys (key, endpoint, response_status, response_body)
     VALUES ($1, $2, NULL, NULL)
     ON CONFLICT (key) DO UPDATE
       SET endpoint        = EXCLUDED.endpoint,
           response_status = NULL,
           response_body   = NULL,
           created_at      = NOW(),
           expires_at      = NOW() + INTERVAL '24 hours'
       WHERE idempotency_keys.expires_at <= NOW()
     RETURNING key`,
    [key, endpoint],
  );
}

/**
 * Busca a linha ativa da key (qualquer endpoint — o middleware compara o
 * endpoint pra detectar reuso incorreto). responseStatus null = claim de
 * request ainda em processamento.
 */
export async function find(key) {
  if (!key) return null;
  return one(
    `SELECT endpoint,
            response_status AS "responseStatus",
            response_body   AS "responseBody"
     FROM idempotency_keys
     WHERE key = $1 AND expires_at > NOW()
     LIMIT 1`,
    [key],
  );
}

/** Grava a response 2xx no claim pra replay futuro do mesmo key. */
export async function saveResponse(key, endpoint, status, body) {
  if (!key) return null;
  return one(
    `UPDATE idempotency_keys
     SET response_status = $3, response_body = $4
     WHERE key = $1 AND endpoint = $2
     RETURNING key`,
    [key, endpoint, status, JSON.stringify(body)],
  );
}

/**
 * Libera o claim (response de erro ou request abortada) — o retry do
 * cliente pode reprocessar em vez de ficar preso num 409 até o TTL.
 */
export async function release(key, endpoint) {
  if (!key) return null;
  return one(
    `DELETE FROM idempotency_keys
     WHERE key = $1 AND endpoint = $2
     RETURNING key`,
    [key, endpoint],
  );
}

/**
 * GC de keys expiradas. Chamado ao final do migrate.js, que roda a cada
 * boot do container (CMD do Dockerfile) — nao ha scheduler dedicado.
 */
export async function cleanupExpired() {
  return one(
    `DELETE FROM idempotency_keys WHERE expires_at < NOW() RETURNING 1`,
  );
}
