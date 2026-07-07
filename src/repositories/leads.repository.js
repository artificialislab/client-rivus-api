/**
 * Repository — early_access_leads.
 *
 * Acesso DB puro. Sem lógica de negócio (essa fica no service).
 * Todas as queries respeitam soft-delete por default (filtro `deleted_at IS NULL`).
 *
 * Cursor pagination: encoded base64. Formato depende do sort:
 *   newest/oldest -> "<iso>|<uuid>"          -> WHERE (created_at, id) </> (...)
 *   score         -> "<score>|<iso>|<uuid>"  -> WHERE (lead_score, created_at, id) < (...)
 * O keyset sempre espelha o ORDER BY do sort correspondente.
 */
import { q, one, pool } from '../db.js';

// Cursor precisa espelhar o ORDER BY do sort. Pra 'score' o keyset e
// (lead_score, created_at, id); pros demais, (created_at, id). Cursor que
// nao casa com o formato do sort e ignorado (volta pra pagina 1) — seguro
// porque o cursor e opaco e regenerado a cada resposta.
function encodeCursor(row, sort) {
  const iso = new Date(row.createdAt).toISOString();
  const raw = sort === 'score'
    ? `${row.leadScore}|${iso}|${row.id}`
    : `${iso}|${row.id}`;
  return Buffer.from(raw).toString('base64url');
}

const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(cursor, sort = 'newest') {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parts = decoded.split('|');
    // Valida data + uuid — cursor malformado (user-supplied) virava
    // "Invalid Date"/uuid inválido no bind do pg e estourava 500.
    if (sort === 'score') {
      if (parts.length !== 3) return null;
      const [scoreStr, iso, id] = parts;
      const leadScore = Number(scoreStr);
      const createdAt = new Date(iso);
      if (!Number.isInteger(leadScore)) return null;
      if (Number.isNaN(createdAt.getTime()) || !CURSOR_UUID_RE.test(id)) return null;
      return { leadScore, createdAt, id };
    }
    if (parts.length !== 2) return null;
    const [iso, id] = parts;
    if (!iso || !id) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime()) || !CURSOR_UUID_RE.test(id)) return null;
    return { createdAt, id };
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
  // Filtros base (compartilhados entre listagem e COUNT). Cursor NÃO entra
  // aqui — é só pra paginação da página atual; o total ignora cursor.
  const baseWhere = [];
  const baseParams = [];
  let pb = 1;

  if (!includeDeleted) baseWhere.push('deleted_at IS NULL');
  if (status && status !== 'all')         { baseWhere.push(`status = $${pb++}`);      baseParams.push(status); }
  if (profile && profile !== 'all')       { baseWhere.push(`profile = $${pb++}`);     baseParams.push(profile); }
  if (volumeBand && volumeBand !== 'all') { baseWhere.push(`volume_band = $${pb++}`); baseParams.push(volumeBand); }
  if (tags && tags.length > 0)            { baseWhere.push(`tags && $${pb++}`);       baseParams.push(tags); }
  if (search) {
    baseWhere.push(`(LOWER(name) LIKE $${pb} OR LOWER(email) LIKE $${pb} OR LOWER(company) LIKE $${pb})`);
    baseParams.push(`%${search.toLowerCase()}%`);
    pb++;
  }

  // Cláusula extra do cursor — só usada na query de listagem.
  const listWhere = [...baseWhere];
  const listParams = [...baseParams];
  let pl = pb;
  if (cursor) {
    const decoded = decodeCursor(cursor, sort);
    if (decoded) {
      if (sort === 'score') {
        // Keyset composto casando com ORDER BY lead_score DESC, created_at DESC, id DESC.
        // Antes o cursor so carregava (created_at, id) e o filtro por data
        // duplicava/pulava rows nas paginas seguintes do sort=score.
        listWhere.push(`(lead_score, created_at, id) < ($${pl++}, $${pl++}, $${pl++})`);
        listParams.push(decoded.leadScore, decoded.createdAt, decoded.id);
      } else if (sort === 'oldest') {
        listWhere.push(`(created_at, id) > ($${pl++}, $${pl++})`);
        listParams.push(decoded.createdAt, decoded.id);
      } else {
        listWhere.push(`(created_at, id) < ($${pl++}, $${pl++})`);
        listParams.push(decoded.createdAt, decoded.id);
      }
    }
  }

  const orderBy = sort === 'oldest' ? 'created_at ASC, id ASC'
    : sort === 'score' ? 'lead_score DESC, created_at DESC, id DESC'
    : 'created_at DESC, id DESC';

  const listWhereSQL = listWhere.length ? `WHERE ${listWhere.join(' AND ')}` : '';
  const baseWhereSQL = baseWhere.length ? `WHERE ${baseWhere.join(' AND ')}` : '';

  // Pega 1 a mais pra detectar se tem próxima página
  const items = await q(
    `SELECT id, reference, name, email, company, phone, profile,
            volume_band AS "volumeBand", origin, note, status, tags,
            lead_score AS "leadScore",
            assigned_to AS "assignedTo",
            created_at AS "createdAt", updated_at AS "updatedAt",
            deleted_at AS "deletedAt"
     FROM early_access_leads ${listWhereSQL}
     ORDER BY ${orderBy}
     LIMIT ${limit + 1}`,
    listParams,
  );

  const hasMore = items.length > limit;
  const slice = hasMore ? items.slice(0, limit) : items;
  const last = slice[slice.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last, sort) : null;

  // Total (sem paginação nem cursor) — útil pro contador da UI.
  const totalRow = await one(
    `SELECT COUNT(*)::int AS c FROM early_access_leads ${baseWhereSQL}`,
    baseParams,
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
