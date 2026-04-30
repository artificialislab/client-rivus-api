/**
 * Repository — early_access_leads.
 *
 * Acesso DB puro. Sem lógica de negócio (essa fica no service).
 * Todas as queries respeitam soft-delete por default (filtro `deleted_at IS NULL`).
 *
 * Cursor pagination: encoded base64 de "<iso>|<uuid>". Decodificado vira
 * WHERE (created_at, id) < (cursor.created_at, cursor.id) — comparação
 * lexicográfica estável.
 */
import { q, one, pool } from '../db.js';

function encodeCursor(createdAt, id) {
  return Buffer.from(`${new Date(createdAt).toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso, id] = decoded.split('|');
    if (!iso || !id) return null;
    return { createdAt: new Date(iso), id };
  } catch {
    return null;
  }
}

/**
 * Insere lead novo. Pre-condição: schema já validado pelo caller.
 * Retorna { id, reference, lead_score }.
 *
 * Caller deve fornecer reference (pre-gerado) — isso permite retry em caso
 * de colisão do unique sem re-validar schema.
 */
export async function insertLead(input, { reference, ipAddress, userAgent }) {
  const inserted = await one(
    `INSERT INTO early_access_leads
       (reference, name, email, company, phone, profile, volume_band,
        origin, note, ip_address, user_agent,
        utm_source, utm_medium, utm_campaign, referrer)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id, reference, lead_score`,
    [
      reference,
      input.name,
      input.email,
      input.company,
      input.phone,
      input.profile,
      input.volumeBand,
      input.origin,
      input.note,
      ipAddress,
      userAgent,
      input.utmSource,
      input.utmMedium,
      input.utmCampaign,
      input.referrer,
    ],
  );
  return inserted;
}

export async function getLeadById(id, { includeDeleted = false } = {}) {
  const where = includeDeleted ? 'WHERE id = $1' : 'WHERE id = $1 AND deleted_at IS NULL';
  return one(
    `SELECT id, reference, name, email, company, phone, profile,
            volume_band AS "volumeBand", origin, note, status, tags,
            utm_source AS "utmSource", utm_medium AS "utmMedium",
            utm_campaign AS "utmCampaign", referrer,
            lead_score AS "leadScore",
            assigned_to AS "assignedTo",
            ip_address::text AS "ipAddress", user_agent AS "userAgent",
            created_at AS "createdAt", updated_at AS "updatedAt",
            deleted_at AS "deletedAt"
     FROM early_access_leads ${where}`,
    [id],
  );
}

/**
 * Lista paginada (cursor-based). Retorna { items, nextCursor }.
 * Filtros opcionais: search (name/email/company), status, profile,
 * volumeBand, tags (array contains).
 */
export async function listLeads({
  search, status, profile, volumeBand, tags,
  sort = 'newest', cursor, limit = 25, includeDeleted = false,
}) {
  const where = [];
  const params = [];
  let p = 1;

  if (!includeDeleted) where.push('deleted_at IS NULL');
  if (status && status !== 'all')         { where.push(`status = $${p++}`);      params.push(status); }
  if (profile && profile !== 'all')       { where.push(`profile = $${p++}`);     params.push(profile); }
  if (volumeBand && volumeBand !== 'all') { where.push(`volume_band = $${p++}`); params.push(volumeBand); }
  if (tags && tags.length > 0)            { where.push(`tags && $${p++}`);       params.push(tags); }
  if (search) {
    where.push(`(LOWER(name) LIKE $${p} OR LOWER(email) LIKE $${p} OR LOWER(company) LIKE $${p})`);
    params.push(`%${search.toLowerCase()}%`);
    p++;
  }

  // Cursor: pula tudo que vem antes do (createdAt, id) do cursor.
  // Pra sort=newest (DESC), seguir = (created_at, id) menor que cursor.
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) {
      if (sort === 'oldest') {
        where.push(`(created_at, id) > ($${p++}, $${p++})`);
      } else {
        where.push(`(created_at, id) < ($${p++}, $${p++})`);
      }
      params.push(decoded.createdAt, decoded.id);
    }
  }

  const orderBy = sort === 'oldest' ? 'created_at ASC, id ASC'
    : sort === 'score' ? 'lead_score DESC, created_at DESC, id DESC'
    : 'created_at DESC, id DESC';

  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Pega 1 a mais pra detectar se tem próxima página
  const items = await q(
    `SELECT id, reference, name, email, company, phone, profile,
            volume_band AS "volumeBand", origin, note, status, tags,
            lead_score AS "leadScore",
            assigned_to AS "assignedTo",
            created_at AS "createdAt", updated_at AS "updatedAt",
            deleted_at AS "deletedAt"
     FROM early_access_leads ${whereSQL}
     ORDER BY ${orderBy}
     LIMIT ${limit + 1}`,
    params,
  );

  const hasMore = items.length > limit;
  const slice = hasMore ? items.slice(0, limit) : items;
  const last = slice[slice.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  // Total (sem paginação) — útil pro contador da UI. Query separada pra
  // não complicar a paginação.
  const totalRow = await one(
    `SELECT COUNT(*)::int AS c FROM early_access_leads ${whereSQL}`,
    params.slice(0, where.length - (cursor ? 2 : 0)),  // remove os 2 params do cursor
  );

  return { items: slice, nextCursor, total: totalRow?.c || 0 };
}

/**
 * Update parcial. Inclui set de session var `app.current_user_id` no
 * mesmo client (transação) pra trigger de history pegar o autor certo.
 * Retorna o lead atualizado, ou null se não existe / está deletado.
 */
export async function updateLead(id, patch, { actorId } = {}) {
  const sets = [];
  const params = [id];
  let p = 2;
  if (patch.status !== undefined)     { sets.push(`status = $${p++}`);      params.push(patch.status); }
  if (patch.tags !== undefined)       { sets.push(`tags = $${p++}`);        params.push(patch.tags); }
  if (patch.assignedTo !== undefined) { sets.push(`assigned_to = $${p++}`); params.push(patch.assignedTo); }
  if (patch.note !== undefined)       { sets.push(`note = $${p++}`);        params.push(patch.note); }
  if (sets.length === 0) return getLeadById(id);

  // Usa client dedicado pra session var sobreviver no UPDATE
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (actorId) {
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [actorId]);
    }
    const res = await client.query(
      `UPDATE early_access_leads SET ${sets.join(', ')}
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, reference, status, tags, assigned_to AS "assignedTo",
                 lead_score AS "leadScore", updated_at AS "updatedAt"`,
      params,
    );
    await client.query('COMMIT');
    return res.rows[0] || null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function softDeleteLead(id) {
  return one(
    `UPDATE early_access_leads SET deleted_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING id, deleted_at AS "deletedAt"`,
    [id],
  );
}

export async function restoreLead(id) {
  return one(
    `UPDATE early_access_leads SET deleted_at = NULL
     WHERE id = $1 AND deleted_at IS NOT NULL
     RETURNING id, deleted_at AS "deletedAt"`,
    [id],
  );
}

export async function getStatusHistory(leadId) {
  return q(
    `SELECT h.id, h.from_status AS "fromStatus", h.to_status AS "toStatus",
            h.comment, h.created_at AS "createdAt",
            COALESCE(u.name, u.email, '(removido)') AS author,
            h.author_id AS "authorId"
     FROM lead_status_history h
     LEFT JOIN admin_users u ON u.id = h.author_id
     WHERE h.lead_id = $1
     ORDER BY h.created_at DESC`,
    [leadId],
  );
}

export const _internals = { encodeCursor, decodeCursor };
