/**
 * Repository — audit_events. Append-only.
 */
import { q, one } from '../db.js';

export async function record({
  requestId, action, actorId, actorEmail, entityType, entityId,
  changes, ip, userAgent,
}) {
  return one(
    `INSERT INTO audit_events
       (request_id, action, actor_id, actor_email, entity_type, entity_id,
        changes, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, created_at AS "createdAt"`,
    [requestId || null, action, actorId || null, actorEmail || null,
     entityType || null, entityId || null,
     changes ? JSON.stringify(changes) : null,
     ip || null, userAgent || null],
  );
}

function encodeCursor(createdAt, id) {
  return Buffer.from(`${new Date(createdAt).toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso, id] = decoded.split('|');
    if (!iso || !id) return null;
    return { createdAt: new Date(iso), id };
  } catch { return null; }
}

export async function list({ action, actorId, entityType, entityId, cursor, limit = 50 } = {}) {
  const where = [];
  const params = [];
  let p = 1;
  if (action)     { where.push(`action = $${p++}`);      params.push(action); }
  if (actorId)    { where.push(`actor_id = $${p++}`);    params.push(actorId); }
  if (entityType) { where.push(`entity_type = $${p++}`); params.push(entityType); }
  if (entityId)   { where.push(`entity_id = $${p++}`);   params.push(entityId); }
  if (cursor) {
    const d = decodeCursor(cursor);
    if (d) {
      where.push(`(created_at, id) < ($${p++}, $${p++})`);
      params.push(d.createdAt, d.id);
    }
  }
  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const items = await q(
    `SELECT id, request_id AS "requestId", action,
            actor_id AS "actorId", actor_email AS "actorEmail",
            entity_type AS "entityType", entity_id AS "entityId",
            changes, ip::text AS ip, user_agent AS "userAgent",
            created_at AS "createdAt"
     FROM audit_events ${whereSQL}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit + 1}`,
    params,
  );
  const hasMore = items.length > limit;
  const slice = hasMore ? items.slice(0, limit) : items;
  const last = slice[slice.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
  return { items: slice, nextCursor };
}

export const _internals = { encodeCursor, decodeCursor };
