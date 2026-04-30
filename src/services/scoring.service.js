/**
 * Lead scoring — espelho JS da função SQL `compute_lead_score`.
 *
 * Mantemos os 2 (SQL + JS) sincronizados pra:
 *   - SQL: trigger calcula automático em insert/update (sem app esquecer)
 *   - JS: testável sem DB, expostável ao frontend pra preview
 *
 * Se alterar a heurística, alterar nos DOIS lugares + bumpar versão.
 */

const VOLUME_BASE = {
  lt_500k: 10,
  '500k_2m': 30,
  '2m_10m': 55,
  '10m_50m': 75,
  gt_50m: 90,
};

const PROFILE_BONUS = { both: 5, seller: 3, buyer: 0 };

export function computeLeadScore({ profile, volumeBand, origin, note }) {
  const base = VOLUME_BASE[volumeBand] || 0;
  let bonus = PROFILE_BONUS[profile] || 0;
  if (origin && String(origin).trim().length > 0) bonus += 3;
  if (note && String(note).trim().length > 0) bonus += 2;
  return Math.min(100, base + bonus);
}

/** Bucket qualitativo pro UI exibir (não persistido). */
export function scoreBucket(score) {
  if (score >= 80) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}
