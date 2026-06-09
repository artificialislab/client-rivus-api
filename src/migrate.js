/**
 * migrate.js — aplica db/*.sql em ordem alfabética. Idempotente.
 *
 * Rodado automaticamente no CMD do Dockerfile antes do server.js subir.
 * Pode ser rodado manualmente:
 *   node src/migrate.js
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { cleanupExpired } from './repositories/idempotency.repository.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.resolve(__dirname, '..', 'db');

async function run() {
  const files = fs.readdirSync(DB_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // eslint-disable-next-line no-console
  console.log(`[migrate] aplicando ${files.length} arquivo(s) SQL de ${DB_DIR}`);

  for (const f of files) {
    const sql = fs.readFileSync(path.join(DB_DIR, f), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[migrate] → ${f} (${sql.length} chars)`);
    await pool.query(sql);
  }

  // GC de idempotency keys expiradas (TTL 24h). O migrate roda a cada boot
  // do container (CMD do Dockerfile), entao este e o ponto natural do cleanup.
  await cleanupExpired();
  // eslint-disable-next-line no-console
  console.log('[migrate] OK');
  await pool.end();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[migrate] FAIL:', err.message);
  process.exit(1);
});
