/**
 * /api/admin/auth — login + logout + me.
 *
 * Login seta cookie httpOnly; me lê cookie e retorna user atual; logout
 * limpa cookie. JWT é stateless (não há tabela de sessions — TTL controla).
 */
import { Router } from 'express';
import { asyncHandler } from '../http.js';
import { loginRateLimit } from '../rateLimit.js';
import {
  verifyPassword,
  signToken,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
} from '../auth.js';

const router = Router();

router.post('/login', loginRateLimit, asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'missing_credentials' });
  }
  const user = await verifyPassword(email, password);
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });

  const token = signToken(user);
  setSessionCookie(res, token);
  res.json({ user });
}));

router.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
