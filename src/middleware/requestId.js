/**
 * requestId middleware — atribui UUID por request, propagado em logs e
 * audit. Aceita header `X-Request-ID` se vier (rastreabilidade end-to-end).
 */
import crypto from 'node:crypto';

export function requestIdMiddleware(req, res, next) {
  const incoming = req.headers['x-request-id'];
  // Aceita só formatos seguros (alfanum + dash + uuid). Sanitiza pra evitar
  // log injection via header malicioso.
  const safe = typeof incoming === 'string' && /^[a-zA-Z0-9-]{8,128}$/.test(incoming) ? incoming : null;
  req.id = safe || crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
}
