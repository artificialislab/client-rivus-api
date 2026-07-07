/**
 * Idempotency middleware (Stripe-style, claim-first).
 *
 * Lê header `Idempotency-Key`. Se presente:
 *   - CLAIM atômico no DB (INSERT ... ON CONFLICT) ANTES de processar —
 *     dois POSTs simultâneos com a mesma key nunca processam duas vezes,
 *     só um ganha o claim.
 *   - Claim ok → processa; response 2xx é gravada via UPDATE pra replay
 *     futuro; response de erro libera o claim (retry pode reprocessar).
 *   - Claim conflitou:
 *       - response já gravada → replay idêntico (Idempotent-Replayed: true);
 *       - linha sem response → request original ainda processando → 409
 *         request_in_progress + Retry-After (retry recebe o replay);
 *       - mesma key em endpoint diferente → 409 idempotency_key_reused.
 *
 * Aplicar SOMENTE em mutations (POST). GET não precisa.
 * Sem header → middleware no-op (passa direto, sem dedup).
 * Falha de DB no idempotency NÃO bloqueia o request — segue sem dedup.
 */
import * as defaultRepo from '../repositories/idempotency.repository.js';
import logger from '../logger.js';

export function idempotencyMiddleware(endpointLabel, repo = defaultRepo) {
  return async (req, res, next) => {
    const key = (req.headers['idempotency-key'] || '').toString().trim();
    if (!key) return next();

    // Sanity: 8-128 chars, alfanum + dash. Qualquer coisa fora rejeita.
    if (!/^[a-zA-Z0-9-]{8,128}$/.test(key)) {
      return res.status(400).json({ error: 'invalid_idempotency_key' });
    }

    let claimed = false;
    try {
      claimed = Boolean(await repo.claim(key, endpointLabel));
      if (!claimed) {
        const existing = await repo.find(key);
        if (existing && existing.endpoint !== endpointLabel) {
          // Mesma key reusada em endpoint diferente = bug do cliente.
          return res.status(409).json({ error: 'idempotency_key_reused' });
        }
        if (existing && existing.responseStatus != null) {
          res.setHeader('Idempotent-Replayed', 'true');
          return res.status(existing.responseStatus).json(existing.responseBody);
        }
        if (existing) {
          // Claim ativo sem response — request original ainda em voo.
          res.setHeader('Retry-After', '2');
          return res.status(409).json({ error: 'request_in_progress' });
        }
        // Linha sumiu entre claim e find (release/GC concorrente) —
        // corrida rara; segue sem dedup em vez de bloquear o lead.
      }
    } catch (err) {
      // Falha no DB do idempotency NÃO bloqueia request — continua sem dedup
      logger.warn({ err: err.message, key, endpoint: endpointLabel }, 'idempotency_claim_failed');
      claimed = false;
    }

    if (claimed) {
      let settled = false;
      const settle = (status, body) => {
        if (settled) return;
        settled = true;
        // Só cacheia respostas determinísticas (2xx). Erros 4xx podem
        // depender de estado mutável (rate-limit, lock) e 5xx são
        // transientes — replayar erro cacheado prenderia o cliente em
        // loop. Erro (ou response sem body json) → libera o claim.
        const persistable = status >= 200 && status < 300 && body !== undefined;
        const op = persistable
          ? repo.saveResponse(key, endpointLabel, status, body)
          : repo.release(key, endpointLabel);
        // Best-effort (não bloqueia a response)
        op.catch((err) => {
          logger.warn({ err: err.message, key, endpoint: endpointLabel }, 'idempotency_settle_failed');
        });
      };

      // Intercepta res.json pra gravar a response no claim antes de enviar
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        settle(res.statusCode || 200, body);
        return originalJson(body);
      };
      // Response sem json (ex.: .end() num error handler) → libera o claim
      // pra não prender retries em 409 até o TTL.
      res.on('finish', () => settle(res.statusCode || 200, undefined));
    }

    next();
  };
}
