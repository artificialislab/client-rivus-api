/**
 * /api/admin/auth — login + logout + me.
 *
 * Service-oriented: lógica em services/auth.service.js. Lockout, audit,
 * timing-safe — tudo lá.
 */
import { Router } from 'express';
import { asyncHandler, clientIp, clientUserAgent } from '../http.js';
import { loginRateLimit } from '../rateLimit.js';
import { validateBody } from '../middleware/validate.js';
import { LoginInputSchema } from '../schemas/auth.js';
import { requireAuth } from '../auth.js';
import * as authService from '../services/auth.service.js';

const router = Router();

router.post(
  '/login',
  loginRateLimit,
  validateBody(LoginInputSchema),
  asyncHandler(async (req, res) => {
    const { user, token } = await authService.login(req.body, {
      ipAddress: clientIp(req),
      userAgent: clientUserAgent(req),
      requestId: req.id,
    });
    authService.setSessionCookie(res, token);
    res.json({ user });
  }),
);

router.post('/logout', asyncHandler(async (req, res) => {
  await authService.logout(req, res);
  res.json({ ok: true });
}));

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
