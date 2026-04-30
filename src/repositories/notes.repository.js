import { q, one } from '../db.js';

export async function listByLead(leadId) {
  return q(
    `SELECT n.id, n.body, n.created_at AS "createdAt",
            COALESCE(u.name, u.email, '(removido)') AS author,
            n.author_id AS "authorId"
     FROM lead_notes n
     LEFT JOIN admin_users u ON u.id = n.author_id
     WHERE n.lead_id = $1
     ORDER BY n.created_at DESC`,
    [leadId],
  );
}

export async function insertNote({ leadId, authorId, body }) {
  return one(
    `INSERT INTO lead_notes (lead_id, author_id, body)
     VALUES ($1, $2, $3)
     RETURNING id, body, created_at AS "createdAt", author_id AS "authorId"`,
    [leadId, authorId, body],
  );
}
