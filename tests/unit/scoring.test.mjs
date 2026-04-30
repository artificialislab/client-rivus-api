/**
 * Unit tests — services/scoring.service.js
 *
 * Lead scoring é função pura (sem I/O). Mantém em sincronia com a função
 * SQL `compute_lead_score` em db/002_robustness.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLeadScore, scoreBucket } from '../../src/services/scoring.service.js';

test('scoring: volume_band base + perfil bonus', () => {
  // Buyer + lt_500k + sem extras = 10
  assert.equal(computeLeadScore({ profile: 'buyer', volumeBand: 'lt_500k' }), 10);
  // Both + 2m_10m + sem extras = 55 + 5 = 60
  assert.equal(computeLeadScore({ profile: 'both', volumeBand: '2m_10m' }), 60);
  // Seller + gt_50m + extras completos = 90 + 3 + 3 + 2 = 98
  assert.equal(
    computeLeadScore({ profile: 'seller', volumeBand: 'gt_50m', origin: 'LinkedIn', note: 'Mesa institucional' }),
    98,
  );
});

test('scoring: cap em 100', () => {
  // Hipotético — se algum bonus subir e somar > 100, deve cappar
  // (cobertura defensiva — gt_50m + both + origin + note = 100 exato)
  assert.equal(
    computeLeadScore({ profile: 'both', volumeBand: 'gt_50m', origin: 'X', note: 'Y' }),
    100,
  );
});

test('scoring: bucket qualitativo', () => {
  assert.equal(scoreBucket(95), 'high');
  assert.equal(scoreBucket(80), 'high');
  assert.equal(scoreBucket(79), 'medium');
  assert.equal(scoreBucket(50), 'medium');
  assert.equal(scoreBucket(49), 'low');
  assert.equal(scoreBucket(0), 'low');
});

test('scoring: handle de input inválido sem crash', () => {
  assert.equal(computeLeadScore({}), 0);
  assert.equal(computeLeadScore({ profile: 'unknown', volumeBand: 'unknown' }), 0);
  assert.equal(computeLeadScore({ profile: 'buyer', volumeBand: 'lt_500k', origin: '   ' }), 10); // origin só whitespace = não conta
});
