/**
 * Lead service — orquestra repository + audit + scoring + side effects.
 *
 * Routes ficam thin (parse + Zod → service → response). Toda regra de
 * negócio mora aqui pra ser testável sem HTTP.
 */
import crypto from 'node:crypto';
import * as leadsRepo from '../repositories/leads.repository.js';
import * as notesRepo from '../repositories/notes.repository.js';
import * as audit from './audit.service.js';
import logger from '../logger.js';

class ServiceError extends Error {
  constructor(message, { status = 400, code } = {}) {
    super(message);
    this.status = status;
    this.code = code || 'service_error';
  }
}

function generateReference() {
  // RIV-XXXXXX (6 chars [A-Z0-9]) — espelha o que o front Lovable gerava localmente.
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  const buf = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) suffix += chars[buf[i] % chars.length];
  return `RIV-${suffix}`;
}

/**
 * Cria lead. Tenta até 3x em caso de colisão de reference (improvável,
 * mas defendido). Audita criação. Retorna { id, reference, leadScore }.
 */
export async function createLead(input, ctx = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const reference = generateReference();
    try {
      const inserted = await leadsRepo.insertLead(input, {
        reference,
        ipAddress: ctx.ipAddress || null,
        userAgent: ctx.userAgent || null,
      });
      // Audit (resiliente)
      audit.record({
        requestId: ctx.requestId,
        action: 'lead.create',
        entityType: 'lead',
        entityId: inserted.id,
        changes: { after: { reference: inserted.reference, profile: input.profile, volumeBand: input.volumeBand } },
        ip: ctx.ipAddress,
        userAgent: ctx.userAgent,
      }).catch(() => {});

      logger.info({ leadId: inserted.id, reference: inserted.reference, score: inserted.lead_score }, 'lead_created');
      return {
        id: inserted.id,
        reference: inserted.reference,
        leadScore: inserted.lead_score,
      };
    } catch (err) {
      // 23505 = unique_violation (reference colidiu — retry)
      if (err.code === '23505') { lastErr = err; continue; }
      throw err;
    }
  }
  throw new ServiceError('reference collision after 3 attempts', { status: 500, code: 'reference_collision' });
}

export async function listLeads(query) {
  return leadsRepo.listLeads(query);
}

export async function getLead(id, opts) {
  const lead = await leadsRepo.getLeadById(id, opts);
  if (!lead) throw new ServiceError('lead não encontrado', { status: 404, code: 'lead_not_found' });
  const notes = await notesRepo.listByLead(id);
  const history = await leadsRepo.getStatusHistory(id);
  return { ...lead, internalNotes: notes, statusHistory: history };
}

export async function patchLead(id, patch, ctx = {}) {
  const before = await leadsRepo.getLeadById(id);
  if (!before) throw new ServiceError('lead não encontrado', { status: 404, code: 'lead_not_found' });

  const updated = await leadsRepo.updateLead(id, patch, { actorId: ctx.actorId });
  if (!updated) {
    // race: alguém deletou enquanto patcheávamos
    throw new ServiceError('lead já foi deletado', { status: 410, code: 'lead_gone' });
  }

  // Diff pro audit (só os campos que mudaram)
  const diff = {};
  if (patch.status !== undefined && patch.status !== before.status)         diff.status     = { from: before.status, to: patch.status };
  if (patch.tags !== undefined)                                              diff.tags       = { from: before.tags, to: patch.tags };
  if (patch.assignedTo !== undefined && patch.assignedTo !== before.assignedTo) diff.assignedTo = { from: before.assignedTo, to: patch.assignedTo };
  if (patch.note !== undefined && patch.note !== before.note)               diff.note       = { from: before.note, to: patch.note };

  audit.record({
    requestId: ctx.requestId,
    action: 'lead.update',
    actorId: ctx.actorId,
    actorEmail: ctx.actorEmail,
    entityType: 'lead',
    entityId: id,
    changes: diff,
    ip: ctx.ipAddress,
    userAgent: ctx.userAgent,
  }).catch(() => {});

  return updated;
}

export async function softDelete(id, ctx = {}) {
  const result = await leadsRepo.softDeleteLead(id);
  if (!result) throw new ServiceError('lead não encontrado ou já deletado', { status: 404, code: 'lead_not_found' });
  audit.record({
    requestId: ctx.requestId,
    action: 'lead.delete',
    actorId: ctx.actorId, actorEmail: ctx.actorEmail,
    entityType: 'lead', entityId: id,
    ip: ctx.ipAddress, userAgent: ctx.userAgent,
  }).catch(() => {});
  return result;
}

export async function restore(id, ctx = {}) {
  const result = await leadsRepo.restoreLead(id);
  if (!result) throw new ServiceError('lead não encontrado ou não estava deletado', { status: 404, code: 'lead_not_deleted' });
  audit.record({
    requestId: ctx.requestId,
    action: 'lead.restore',
    actorId: ctx.actorId, actorEmail: ctx.actorEmail,
    entityType: 'lead', entityId: id,
    ip: ctx.ipAddress, userAgent: ctx.userAgent,
  }).catch(() => {});
  return result;
}

export async function addNote(leadId, body, ctx = {}) {
  const lead = await leadsRepo.getLeadById(leadId);
  if (!lead) throw new ServiceError('lead não encontrado', { status: 404, code: 'lead_not_found' });
  const note = await notesRepo.insertNote({ leadId, authorId: ctx.actorId, body });
  audit.record({
    requestId: ctx.requestId,
    action: 'lead.note_add',
    actorId: ctx.actorId, actorEmail: ctx.actorEmail,
    entityType: 'lead', entityId: leadId,
    changes: { noteId: note.id },
    ip: ctx.ipAddress, userAgent: ctx.userAgent,
  }).catch(() => {});
  return note;
}

export { ServiceError };
