/**
 * /api/early-access — endpoint público pro formulário do site.
 *
 * Implementa o contrato `LeadsApi#submit` que o Lovable já consome
 * (LeadInput → { id, reference }). Rate-limited por IP. Captura ip_address
 * + user_agent pra triagem anti-bot.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { one } from '../db.js';
import { asyncHandler, clientIp, clientUserAgent } from '../http.js';
import { leadsRateLimit } from '../rateLimit.js';

const router = Router();

const VALID_PROFILES = new Set(['buyer', 'seller', 'both']);
const VALID_BANDS = new Set(['lt_500k', '500k_2m', '2m_10m', '10m_50m', 'gt_50m']);

function generateReference() {
  // RIV-XXXXXX (6 chars [A-Z0-9]) — espelha o que o Lovable gerava localmente.
  // Probabilidade de colisão: 36^6 ≈ 2.2 bi. Em escala normal de leads,
  // colisão é improvável. UNIQUE INDEX no DB protege se acontecer.
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  const buf = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    suffix += chars[buf[i] % chars.length];
  }
  return `RIV-${suffix}`;
}

function trimOrNull(v, max = 1000) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

router.post('/leads', leadsRateLimit, asyncHandler(async (req, res) => {
  const body = req.body || {};

  // Validação manual — sem Zod pra manter deps mínimas.
  const errors = [];
  const name = trimOrNull(body.name, 200);
  const email = trimOrNull(body.email, 200);
  const company = trimOrNull(body.company, 200);
  const phone = trimOrNull(body.phone, 50);
  const profile = body.profile;
  const volumeBand = body.volumeBand;
  const origin = trimOrNull(body.origin, 200);
  const note = trimOrNull(body.note, 500);

  if (!name || name.length < 2) errors.push('name');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('email');
  if (!company || company.length < 2) errors.push('company');
  if (!phone || phone.replace(/\D/g, '').length < 8) errors.push('phone');
  if (!VALID_PROFILES.has(profile)) errors.push('profile');
  if (!VALID_BANDS.has(volumeBand)) errors.push('volumeBand');

  if (errors.length > 0) {
    return res.status(400).json({ error: 'validation_failed', fields: errors });
  }

  // Tenta inserir; em colisão de reference (improvável), retry uma vez.
  for (let attempt = 0; attempt < 2; attempt++) {
    const reference = generateReference();
    try {
      const inserted = await one(
        `INSERT INTO early_access_leads
           (reference, name, email, company, phone, profile, volume_band,
            origin, note, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, reference`,
        [
          reference,
          name,
          email.toLowerCase(),
          company,
          phone,
          profile,
          volumeBand,
          origin,
          note,
          clientIp(req),
          clientUserAgent(req),
        ],
      );
      return res.status(201).json({ id: inserted.id, reference: inserted.reference });
    } catch (err) {
      // 23505 = unique_violation. Outro erro = bubble up pro error handler.
      if (err.code !== '23505') throw err;
      if (attempt === 1) {
        // eslint-disable-next-line no-console
        console.error('[leads] colisão de reference em duas tentativas — espaço degradado?');
        return res.status(500).json({ error: 'reference_collision' });
      }
    }
  }
  return res.status(500).json({ error: 'unexpected_state' });
}));

export default router;
