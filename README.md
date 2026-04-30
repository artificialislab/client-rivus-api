# Rivus API

API HTTP do Rivus — early-access leads + auth admin. Stack próprio do cliente, provisionado automaticamente pela plataforma Artificialis via recipe `rivus-api` em `serviceRecipes.js`.

## Endpoints

### Público
- `POST /api/early-access/leads` — cria lead. Rate-limited 5/IP a cada 10min. Validação manual dos campos do `LeadInput` que o front Lovable consome.

### Admin (cookie httpOnly)
- `POST /api/admin/auth/login` — `{ email, password }` → seta cookie + retorna `{ user }`.
- `POST /api/admin/auth/logout` — limpa cookie.
- `GET /api/admin/auth/me` — retorna user atual (401 se não logado).
- `GET /api/admin/leads` — lista paginada com filtros (`search`, `status`, `profile`, `volumeBand`, `sort`, `page`, `pageSize`).
- `GET /api/admin/leads/:id` — detalhe + `internalNotes`.
- `PATCH /api/admin/leads/:id/status` — `{ status }` ∈ `new|contacted|qualified|rejected|converted`.
- `POST /api/admin/leads/:id/notes` — `{ body }`.
- `GET /api/admin/leads/export.csv` — mesmos filtros, retorna CSV completo.

### Provisioning (interno)
- `POST /admin/seed` — header `X-Seed-Token`. Cria conta admin inicial. Idempotente (409 se já existe).

### Healthcheck
- `GET /health` — 200 OK + status do pool Postgres.

## Schema

Ver `db/001_init.sql`. Tabelas:
- `admin_users` — operadores internos (id, email, name, role, password_hash).
- `early_access_leads` — leads do formulário (reference, name, email, company, phone, profile, volume_band, origin, note, status, ip_address, user_agent).
- `lead_notes` — notas internas por lead (FK lead + author).

Migrations idempotentes via `src/migrate.js` (rodado no startup do container).

## Dev local

```bash
cp .env.example .env
# edita .env com DATABASE_URL local
npm install
npm run migrate
npm run seed-admin admin@rivus.trading senha-forte "Admin Inicial"
npm run dev
```

## Deploy

Provisionado via plataforma Artificialis. No painel admin → tenant Rivus → Install Service → marcar `rivus-api`. O pipeline:
1. Pull da imagem `ghcr.io/artificialislab/rivus-api:1.0.0`.
2. Sobe container `rivus-rivus-api` na network do tenant.
3. Executa `migrate.js` (idempotente).
4. Auto-seed do admin (passa email no install — senha gerada e exibida 1x).
5. Caddy do gateway adiciona handle `/api/*` → `127.0.0.1:<port>` no vhost.

## Reset de senha admin

```bash
docker compose exec rivus-api node src/seed-admin.js admin@rivus.trading nova-senha
```

## Versionamento

Tag `vX.Y.Z` no git → CI publica `ghcr.io/artificialislab/rivus-api:X.Y.Z` (sem `v` — `docker/metadata-action` strip). Atualizar `SERVICE_VERSIONS['rivus-api']` no `serviceRecipes.js` do `website` repo pra propagar.
