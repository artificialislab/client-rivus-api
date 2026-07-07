/**
 * Unit tests — cursor keyset de listLeads.
 *
 * Regressao: sort=score ordenava por (lead_score, created_at, id) mas o
 * cursor so carregava (created_at, id) — paginas 2+ duplicavam/pulavam rows.
 * Agora o cursor de score carrega o score e o keyset casa com o ORDER BY.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// O repository real importa src/db.js, que exige DATABASE_URL no load.
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test_db';
const { _internals } = await import('../../src/repositories/leads.repository.js');

const { encodeCursor, decodeCursor } = _internals;

const ROW = {
  leadScore: 42,
  createdAt: '2026-07-01T12:00:00.000Z',
  id: '0b0e8a52-1111-4222-8333-444455556666',
};

test('cursor score: roundtrip encode/decode carrega lead_score', () => {
  const c = encodeCursor(ROW, 'score');
  const d = decodeCursor(c, 'score');
  assert.ok(d);
  assert.equal(d.leadScore, 42);
  assert.equal(d.createdAt.toISOString(), ROW.createdAt);
  assert.equal(d.id, ROW.id);
});

test('cursor newest/oldest: roundtrip sem score', () => {
  for (const sort of ['newest', 'oldest']) {
    const c = encodeCursor(ROW, sort);
    const d = decodeCursor(c, sort);
    assert.ok(d, sort);
    assert.equal(d.createdAt.toISOString(), ROW.createdAt);
    assert.equal(d.id, ROW.id);
    assert.equal('leadScore' in d, false);
  }
});

test('cursor de outro sort e rejeitado (null => volta pra pagina 1)', () => {
  const scoreCursor = encodeCursor(ROW, 'score');
  const newestCursor = encodeCursor(ROW, 'newest');
  assert.equal(decodeCursor(scoreCursor, 'newest'), null);
  assert.equal(decodeCursor(newestCursor, 'score'), null);
});

test('cursor malformado e rejeitado', () => {
  for (const bad of [
    Buffer.from('nao-e-cursor').toString('base64url'),
    Buffer.from('x|2026-07-01T00:00:00Z|not-a-uuid').toString('base64url'),
    Buffer.from('12.5|2026-07-01T00:00:00Z|' + ROW.id).toString('base64url'), // score nao-inteiro
    Buffer.from('abc|' + ROW.id).toString('base64url'), // data invalida
    '@@@',
  ]) {
    assert.equal(decodeCursor(bad, 'score') ?? decodeCursor(bad, 'newest'), null, bad);
  }
});
