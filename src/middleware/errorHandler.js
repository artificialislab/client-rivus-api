/**
 * Error handler centralizado. Padroniza shape de erro pro frontend e
 * loga com requestId pra correlação.
 *
 * Hierarquia:
 *   - cors_blocked → 403
 *   - entity.parse.failed → 400 invalid_json
 *   - entity.too.large → 413 payload_too_large
 *   - err.status (ServiceError, AuthError) → status custom
 *   - 4xx genérico → bad_request
 *   - 5xx → internal_error (NÃO vaza err.message pra cliente em prod)
 */
import logger from '../logger.js';

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;

  const requestId = req.id;

  if (err.message === 'cors_blocked') {
    return res.status(403).json({ error: 'cors_blocked', requestId });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', requestId });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large', requestId });
  }

  // ServiceError / AuthError — status + code custom
  const status = Number(err.status || err.statusCode);
  if (status >= 400 && status < 500) {
    logger.info({ err: err.message, code: err.code, status, requestId, path: req.path }, 'request_failed');
    return res.status(status).json({
      error: err.code || 'bad_request',
      message: err.message,
      ...(err.details && { details: err.details }),
      requestId,
    });
  }

  // 5xx — log com stack, mas response sem detalhes (security)
  logger.error({ err: err.stack || err.message, requestId, path: req.path, method: req.method }, 'internal_error');
  res.status(500).json({
    error: 'internal_error',
    message: process.env.NODE_ENV === 'production' ? 'Erro interno' : (err.message || 'erro inesperado'),
    requestId,
  });
}

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'not_found' });
}
