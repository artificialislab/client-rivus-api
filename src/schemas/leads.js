/**
 * Zod schemas — leads.
 *
 * Single source of truth pra validação + types. Mesmas constantes que o
 * front Lovable consome (LeadInput em src/lib/api/leads.ts).
 */
import { z } from 'zod';

export const PROFILES = ['buyer', 'seller', 'both'];
export const VOLUME_BANDS = ['lt_500k', '500k_2m', '2m_10m', '10m_50m', 'gt_50m'];
export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'rejected', 'converted'];

// ─── POST /api/early-access/leads ─────────────────────────────────────────
export const LeadInputSchema = z.object({
  name:        z.string().trim().min(2).max(200),
  email:       z.string().trim().toLowerCase().email().max(200),
  company:     z.string().trim().min(2).max(200),
  // Aceita formato livre, valida >= 8 dígitos numéricos
  phone:       z.string().trim().max(50).refine(
                 (s) => s.replace(/\D/g, '').length >= 8,
                 { message: 'phone must have at least 8 digits' },
               ),
  profile:     z.enum(PROFILES),
  volumeBand:  z.enum(VOLUME_BANDS),
  origin:      z.string().trim().max(200).optional().nullable().transform((v) => v || null),
  note:        z.string().trim().max(500).optional().nullable().transform((v) => v || null),
  // Tracking opcional (UTM + referrer) — geralmente vem do query string do site
  utmSource:   z.string().trim().max(100).optional().nullable().transform((v) => v || null),
  utmMedium:   z.string().trim().max(100).optional().nullable().transform((v) => v || null),
  utmCampaign: z.string().trim().max(100).optional().nullable().transform((v) => v || null),
  referrer:    z.string().trim().max(500).optional().nullable().transform((v) => v || null),
});

// ─── GET /api/admin/leads — query string ──────────────────────────────────
export const LeadsListQuerySchema = z.object({
  search:     z.string().trim().max(200).optional(),
  status:     z.union([z.enum(LEAD_STATUSES), z.literal('all')]).optional(),
  profile:    z.union([z.enum(PROFILES), z.literal('all')]).optional(),
  volumeBand: z.union([z.enum(VOLUME_BANDS), z.literal('all')]).optional(),
  tags:       z.string().trim().optional(),  // comma-separated, ex: "high-value,verified"
  sort:       z.enum(['newest', 'oldest', 'score']).optional().default('newest'),
  // Cursor pagination — base64 de "<created_at_iso>|<id>"
  cursor:     z.string().optional(),
  limit:      z.coerce.number().int().min(5).max(100).optional().default(25),
  // Inclui soft-deleted? Default false.
  includeDeleted: z.coerce.boolean().optional().default(false),
});

// ─── PATCH /api/admin/leads/:id ───────────────────────────────────────────
// Todos campos opcionais — passa só os que quer mudar.
export const LeadPatchSchema = z.object({
  status:      z.enum(LEAD_STATUSES).optional(),
  tags:        z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  assignedTo:  z.string().uuid().nullable().optional(),
  note:        z.string().trim().max(500).optional().nullable(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'pelo menos um campo deve ser fornecido' },
);

// ─── POST /api/admin/leads/:id/notes ──────────────────────────────────────
export const NoteInputSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

// ─── GET /api/admin/audit ─────────────────────────────────────────────────
export const AuditQuerySchema = z.object({
  action:      z.string().trim().max(100).optional(),
  actorId:     z.string().uuid().optional(),
  entityType:  z.string().trim().max(50).optional(),
  entityId:    z.string().uuid().optional(),
  cursor:      z.string().optional(),
  limit:       z.coerce.number().int().min(5).max(200).optional().default(50),
});
