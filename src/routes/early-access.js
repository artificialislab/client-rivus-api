/**
 * /api/early-access — endpoint público pro formulário do site.
 *
 * Thin route: validate Zod → service → response. Toda lógica em
 * services/leads.service.js. Idempotency-Key opcional (Stripe-style).
 */
import { Router } from 'express';
import { asyncHandler, clientIp, clientUserAgent } from '../http.js';
import { leadsRateLimit } from '../rateLimit.js';
import { validateBody } from '../middleware/validate.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { LeadInputSchema } from '../schemas/leads.js';
import * as leadsService from '../services/leads.service.js';

const router = Router();

// Ordem importa: idempotency ANTES de rate-limit. Se o cliente reenvia o
// mesmo Idempotency-Key (retry de rede após sucesso), idempotency dedup
// retorna a resposta cached SEM bater no rate-limit. Sem essa ordem, retry
// legítimo do mesmo POST conta no rate e bloqueia o cliente.
router.post(
  '/leads',
  idempotencyMiddleware('POST /api/early-access/leads'),
  leadsRateLimit,
  validateBody(LeadInputSchema),
  asyncHandler(async (req, res) => {
    const result = await leadsService.createLead(req.body, {
      ipAddress: clientIp(req),
      userAgent: clientUserAgent(req),
      requestId: req.id,
    });
    res.status(201).json(result);
  }),
);

export default router;
