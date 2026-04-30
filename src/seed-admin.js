/**
 * seed-admin.js — CLI pra criar/resetar admin do Rivus.
 *
 * Uso:
 *   docker compose exec rivus-api node src/seed-admin.js <email> <senha> [nome]
 *
 * Comportamento:
 *   - Se email não existe → cria com role 'admin'.
 *   - Se email existe → atualiza password_hash (reset de senha).
 *   - Senha em plain text vai como argv — nunca commitar nada.
 */
import 'dotenv/config';
import { one } from './db.js';
import { hashPassword } from './auth.js';

async function main() {
  const [, , email, password, ...nameParts] = process.argv;
  const name = nameParts.join(' ') || null;

  if (!email || !password) {
    // eslint-disable-next-line no-console
    console.error('Uso: node src/seed-admin.js <email> <senha> [nome]');
    process.exit(1);
  }
  if (password.length < 8) {
    // eslint-disable-next-line no-console
    console.error('Senha deve ter no mínimo 8 chars.');
    process.exit(1);
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const hash = await hashPassword(password);

  const existing = await one(
    `SELECT id, email FROM admin_users WHERE LOWER(email) = $1 LIMIT 1`,
    [normalizedEmail],
  );

  if (existing) {
    await one(
      `UPDATE admin_users SET password_hash = $1, name = COALESCE($2, name) WHERE id = $3 RETURNING id, email`,
      [hash, name, existing.id],
    );
    // eslint-disable-next-line no-console
    console.log(`[seed-admin] senha atualizada para ${normalizedEmail}`);
  } else {
    const inserted = await one(
      `INSERT INTO admin_users (email, password_hash, name, role)
       VALUES ($1, $2, $3, 'admin')
       RETURNING id, email, name, role, created_at`,
      [normalizedEmail, hash, name || normalizedEmail.split('@')[0]],
    );
    // eslint-disable-next-line no-console
    console.log(`[seed-admin] criado: ${JSON.stringify(inserted)}`);
  }
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[seed-admin] FAIL:', err.message);
  process.exit(1);
});
