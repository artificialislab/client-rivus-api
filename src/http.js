/**
 * Helpers HTTP — wrappers reutilizáveis pras rotas Express.
 */

/** Wrap async handler pra erros virem pro middleware sem try/catch boilerplate. */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Pega IP real respeitando trust proxy + X-Forwarded-For do Caddy. */
export function clientIp(req) {
  return req.ip || req.headers['x-real-ip'] || req.socket?.remoteAddress || null;
}

/** Trunca user-agent pra max N chars (proteção contra bloated DB). */
export function clientUserAgent(req, max = 500) {
  const ua = req.headers['user-agent'] || '';
  return String(ua).slice(0, max);
}
