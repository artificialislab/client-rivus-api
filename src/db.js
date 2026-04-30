/**
 * Pool Postgres compartilhado. Conecta no DB dedicado do tenant via
 * DATABASE_URL. Shape em produção:
 *   postgresql://<slug>:<senha>@postgres:5432/<slug>_rivus
 *
 * O hostname `postgres` é o alias do serviço postgres no docker-compose
 * gerado pelo serviceRecipes.js (plataforma Artificialis).
 */
import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL ausente. Setar conexão Postgres no .env.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[pg pool error]', err.message);
});

/** Helper: query parametrizada retornando rows. */
export async function q(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

/** Helper: query retornando o primeiro row ou null. */
export async function one(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}
