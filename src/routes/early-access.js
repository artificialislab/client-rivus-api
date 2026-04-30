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

router.post(
  '/leads',
  leadsRateLimit,
  idempotencyMiddleware('POST /api/early-access/leads'),
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
