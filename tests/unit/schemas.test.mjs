/**
 * Unit tests — Zod schemas. Garante o contrato com o front Lovable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LeadInputSchema, LeadsListQuerySchema, LeadPatchSchema, NoteInputSchema,
  PROFILES, VOLUME_BANDS, LEAD_STATUSES,
} from '../../src/schemas/leads.js';
import { LoginInputSchema } from '../../src/schemas/auth.js';

test('LeadInputSchema: aceita payload completo', () => {
  const result = LeadInputSchema.safeParse({
    name: 'Maria Silva',
    email: 'maria@desk.com',
    company: 'Empresa LTDA',
    phone: '+55 11 99999-9999',
    profile: 'buyer',
    volumeBand: '2m_10m',
    origin: 'LinkedIn',
    note: 'Mesa institucional, +50M',
    utmSource: 'twitter',
    utmCampaign: 'launch-2026',
  });
  assert.ok(result.success, JSON.stringify(result.error?.errors));
  assert.equal(result.data.email, 'maria@desk.com');
  assert.equal(result.data.referrer, null);  // default null pra opcional ausente
});

test('LeadInputSchema: rejeita phone com menos de 8 dígitos', () => {
  const result = LeadInputSchema.safeParse({
    name: 'Maria Silva', email: 'm@m.com', company: 'X',
    phone: '1234567', profile: 'buyer', volumeBand: 'lt_500k',
  });
  assert.equal(result.success, false);
  assert.ok(result.error.errors.some((e) => e.path.includes('phone')));
});

test('LeadInputSchema: normaliza email pra lowercase', () => {
  const result = LeadInputSchema.safeParse({
    name: 'João Silva', email: 'JOAO@DOMAIN.COM', company: 'Empresa LTDA',
    phone: '11999999999', profile: 'buyer', volumeBand: 'lt_500k',
  });
  assert.ok(result.success, JSON.stringify(result.error?.errors));
  assert.equal(result.data.email, 'joao@domain.com');
});

test('LeadInputSchema: rejeita profile/volumeBand fora do enum', () => {
  for (const bad of [
    { profile: 'investor', volumeBand: '2m_10m' },
    { profile: 'buyer', volumeBand: '100m' },
  ]) {
    const result = LeadInputSchema.safeParse({
      name: 'João Silva', email: 'x@x.com', company: 'Empresa',
      phone: '11999999999', ...bad,
    });
    assert.equal(result.success, false);
  }
});

test('LeadsListQuerySchema: defaults aplicados', () => {
  const result = LeadsListQuerySchema.safeParse({});
  assert.ok(result.success);
  assert.equal(result.data.sort, 'newest');
  assert.equal(result.data.limit, 25);
  assert.equal(result.data.includeDeleted, false);
});

test('LeadsListQuerySchema: limit clamped 5-100', () => {
  assert.equal(LeadsListQuerySchema.safeParse({ limit: 1 }).success, false);
  assert.equal(LeadsListQuerySchema.safeParse({ limit: 200 }).success, false);
  assert.equal(LeadsListQuerySchema.safeParse({ limit: 50 }).data.limit, 50);
});

test('LeadPatchSchema: rejeita objeto vazio', () => {
  const result = LeadPatchSchema.safeParse({});
  assert.equal(result.success, false);
});

test('LeadPatchSchema: aceita um campo só', () => {
  assert.ok(LeadPatchSchema.safeParse({ status: 'contacted' }).success);
  assert.ok(LeadPatchSchema.safeParse({ tags: ['priority', 'verified'] }).success);
  assert.ok(LeadPatchSchema.safeParse({ assignedTo: '00000000-0000-0000-0000-000000000000' }).success);
});

test('NoteInputSchema: respeita tamanho min/max', () => {
  assert.equal(NoteInputSchema.safeParse({ body: '' }).success, false);
  assert.ok(NoteInputSchema.safeParse({ body: 'ok' }).success);
  assert.equal(NoteInputSchema.safeParse({ body: 'X'.repeat(2001) }).success, false);
});

test('LoginInputSchema: email + password mínimos', () => {
  assert.ok(LoginInputSchema.safeParse({ email: 'a@b.com', password: '12345678' }).success);
  assert.equal(LoginInputSchema.safeParse({ email: 'invalid', password: '12345678' }).success, false);
  assert.equal(LoginInputSchema.safeParse({ email: 'a@b.com', password: 'short' }).success, false);
});

test('Constantes exportadas batem com o front Lovable', () => {
  assert.deepEqual(PROFILES, ['buyer', 'seller', 'both']);
  assert.deepEqual(VOLUME_BANDS, ['lt_500k', '500k_2m', '2m_10m', '10m_50m', 'gt_50m']);
  assert.deepEqual(LEAD_STATUSES, ['new', 'contacted', 'qualified', 'rejected', 'converted']);
});
