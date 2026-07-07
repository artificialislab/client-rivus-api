/**
 * Unit tests — idempotencyMiddleware (claim-first), sem DB real.
 * O middleware aceita o repository por injeção (2o argumento), então
 * mockamos claim/find/saveResponse/release em memória.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// O repository real importa src/db.js, que exige DATABASE_URL no load.
// O pg.Pool não conecta até a primeira query, então um valor dummy basta.
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test_db';
const { idempotencyMiddleware } = await import('../../src/middleware/idempotency.js');

const ENDPOINT = 'POST /api/early-access/leads';
const KEY = 'abcd1234-key';

function makeReq(key) {
  return { headers: key ? { 'idempotency-key': key } : {} };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    listeners: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    json(body) { this.body = body; this.emit('finish'); return this; },
    on(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    emit(ev) { for (const fn of this.listeners[ev] || []) fn(); },
  };
}

function makeRepo(overrides = {}) {
  const calls = { claim: [], find: [], saveResponse: [], release: [] };
  return {
    calls,
    async claim(...a) { calls.claim.push(a); return { key: a[0] }; },
    async find(...a) { calls.find.push(a); return null; },
    async saveResponse(...a) { calls.saveResponse.push(a); return { key: a[0] }; },
    async release(...a) { calls.release.push(a); return { key: a[0] }; },
    ...overrides,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

test('sem header: no-op, não toca no repo', async () => {
  const repo = makeRepo();
  let nextCalled = false;
  await idempotencyMiddleware(ENDPOINT, repo)(makeReq(null), makeRes(), () => { nextCalled = true; });
  assert.ok(nextCalled);
  assert.equal(repo.calls.claim.length, 0);
});

test('key inválida: 400 sem tocar no repo', async () => {
  const repo = makeRepo();
  const res = makeRes();
  await idempotencyMiddleware(ENDPOINT, repo)(makeReq('curta'), res, () => {
    assert.fail('next não deveria rodar');
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_idempotency_key');
  assert.equal(repo.calls.claim.length, 0);
});

test('claim ganho + response 2xx: processa e grava via saveResponse', async () => {
  const repo = makeRepo();
  const res = makeRes();
  let nextCalled = false;
  await idempotencyMiddleware(ENDPOINT, repo)(makeReq(KEY), res, () => { nextCalled = true; });
  assert.ok(nextCalled);
  assert.deepEqual(repo.calls.claim, [[KEY, ENDPOINT]]);

  // Simula o handler respondendo 201
  res.status(201).json({ lead: { id: 1 } });
  await flush();
  assert.deepEqual(repo.calls.saveResponse, [[KEY, ENDPOINT, 201, { lead: { id: 1 } }]]);
  assert.equal(repo.calls.release.length, 0);
  assert.equal(res.headers['Idempotent-Replayed'], undefined);
});

test('claim ganho + response de erro: libera o claim (release), não cacheia', async () => {
  const repo = makeRepo();
  const res = makeRes();
  await idempotencyMiddleware(ENDPOINT, repo)(makeReq(KEY), res, () => {});
  res.status(422).json({ error: 'validation' });
  await flush();
  assert.equal(repo.calls.saveResponse.length, 0);
  assert.deepEqual(repo.calls.release, [[KEY, ENDPOINT]]);
});

test('claim ganho + response sem json (finish): libera o claim', async () => {
  const repo = makeRepo();
  const res = makeRes();
  await idempotencyMiddleware(ENDPOINT, repo)(makeReq(KEY), res, () => {});
  res.statusCode = 500;
  res.emit('finish');
  await flush();
  assert.equal(repo.calls.saveResponse.length, 0);
  assert.deepEqual(repo.calls.release, [[KEY, ENDPOINT]]);
});

test('conflito + response gravada: replay idêntico com header', async () => {
  const repo = makeRepo({
    async claim() { return null; },
    async find() {
      return { endpoint: ENDPOINT, responseStatus: 201, responseBody: { lead: { id: 7 } } };
    },
  });
  const res = makeRes();
  await idempotencyMiddleware(ENDPOINT, repo)(makeReq(KEY), res, () => {
    assert.fail('next não deveria rodar num replay');
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { lead: { id: 7 } });
  assert.equal(res.headers['Idempotent-Replayed'], 'true');
});

test('conflito + claim em voo (sem response): 409 request_in_progress', async () => {
  const repo = makeRepo({
    async claim() { return null; },
    async find() {
      return { endpoint: ENDPOINT, responseStatus: null, responseBody: null };
    },
  });
  const res = makeRes();
  await idempotencyMiddleware(ENDPOINT, repo)(makeReq(KEY), res, () => {
    assert.fail('next não deveria rodar com claim em voo');
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'request_in_progress');
  assert.equal(res.headers['Retry-After'], '2');
});

test('conflito + key reusada em outro endpoint: 409 idempotency_key_reused', async () => {
  const repo = makeRepo({
    async claim() { return null; },
    async find() {
      return { endpoint: 'POST /api/outra-rota', responseStatus: 201, responseBody: {} };
    },
  });
  const res = makeRes();
  await idempotencyMiddleware(ENDPOINT, repo)(makeReq(KEY), res, () => {
    assert.fail('next não deveria rodar com endpoint divergente');
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'idempotency_key_reused');
});

test('DB fora do ar no claim: segue sem dedup (não bloqueia o lead)', async () => {
  const repo = makeRepo({
    async claim() { throw new Error('connection refused'); },
  });
  const res = makeRes();
  let nextCalled = false;
  await idempotencyMiddleware(ENDPOINT, repo)(makeReq(KEY), res, () => { nextCalled = true; });
  assert.ok(nextCalled);
  // Sem claim ganho, response não deve tentar gravar nada
  res.status(201).json({ ok: true });
  await flush();
  assert.equal(repo.calls.saveResponse.length, 0);
  assert.equal(repo.calls.release.length, 0);
});

test('corrida: 2 requests simultâneas, só uma processa, a outra leva 409', async () => {
  // Repo em memória com claim atômico (Map síncrona = atomicidade simulada)
  const rows = new Map();
  const repo = {
    async claim(key, endpoint) {
      if (rows.has(key)) return null;
      rows.set(key, { endpoint, responseStatus: null, responseBody: null });
      return { key };
    },
    async find(key) { return rows.get(key) || null; },
    async saveResponse(key, endpoint, status, body) {
      const row = rows.get(key);
      if (row) { row.responseStatus = status; row.responseBody = body; }
      return { key };
    },
    async release(key) { rows.delete(key); return { key }; },
  };
  const mw = idempotencyMiddleware(ENDPOINT, repo);

  const resA = makeRes();
  const resB = makeRes();
  let processed = 0;
  await Promise.all([
    mw(makeReq(KEY), resA, () => { processed += 1; }),
    mw(makeReq(KEY), resB, () => { processed += 1; }),
  ]);
  assert.equal(processed, 1, 'somente o vencedor do claim processa');
  const loser = resA.statusCode === 409 ? resA : resB;
  assert.equal(loser.statusCode, 409);
  assert.equal(loser.body.error, 'request_in_progress');
});
