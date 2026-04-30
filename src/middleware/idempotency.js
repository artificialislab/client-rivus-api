/**
 * Idempotency middleware (Stripe-style).
 *
 * Lê header `Idempotency-Key`. Se presente:
 *   - Resolve no DB; se já existe response gravada, retorna a mesma.
 *   - Se não existe, intercepta res.json/res.send pra gravar a response
 *     antes de enviar — dedup futuro retorna idêntica.
 *
 * Aplicar SOMENTE em mutations (POST). GET não precisa.
 *
 * Sem header → middleware no-op (passa direto, sem dedup).
 */
import * as idempotencyRepo from '../repositories/idempotency.repository.js';
import logger from '../logger.js';

export function idempotencyMiddleware(endpointLabel) {
  return async (req, res, next) => {
    const key = (req.headers['idempotency-key'] || '').toString().trim();
    if (!key) return next();

    // Sanity: 8-128 chars, alfanum + dash. Qualquer coisa fora rejeita.
    if (!/^[a-zA-Z0-9-]{8,128}$/.test(key)) {
      return res.status(400).json({ error: 'invalid_idempotency_key' });
    }

    try {
      const cached = await idempotencyRepo.resolve(key, endpointLabel);
      if (cached) {
        res.setHeader('Idempotent-Replayed', 'true');
        return res.status(cached.responseStatus).json(cached.responseBody);
      }
    } catch (err) {
      // Falha no DB do idempotency NÃO bloqueia request — continua sem dedup
      logger.warn({ err: err.message, key, endpoint: endpointLabel }, 'idempotency_resolve_failed');
      return next();
    }

    // Intercepta res.json pra gravar antes de enviar
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // Status pode não ter sido setado ainda — defaultJa pra 200
      const status = res.statusCode || 200;
      // Best-effort gravar (não bloqueia response)
      idempotencyRepo.record(key, endpointLabel, status, body).catch((err) => {
        logger.warn({ err: err.message, key, endpoint: endpointLabel }, 'idempotency_record_failed');
      });
      return originalJson(body);
    };

    next();
  };
}
