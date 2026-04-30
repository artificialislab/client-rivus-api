/**
 * Rate limiters Express — protegem endpoints públicos contra abuso.
 *
 * - leadsRateLimit: POST /api/early-access/leads — 5 req/IP a cada 10min.
 *   Limite alto o suficiente pra dev/QA não atrapalhar, baixo o suficiente
 *   pra bot não criar 1000 leads.
 * - seedRateLimit: POST /admin/seed — 10 req/IP por hora. Endpoint só
 *   bate uma vez em produção (provisioning), limite generoso pro caso de
 *   retry legítimo.
 * - loginRateLimit: POST /admin/auth/login — 10 req/IP a cada 5min.
 *   Slow brute-force enumeration sem incomodar admin tentando de novo.
 */
import rateLimit from 'express-rate-limit';

export const leadsRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Limite de envios excedido. Tente novamente em alguns minutos.' },
});

export const seedRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

export const loginRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});
