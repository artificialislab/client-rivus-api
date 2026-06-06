# Auditoria técnica — client-rivus-api

**Data:** 2026-06-06
**Auditor:** Claude (auditor técnico sênior, modo read-mostly)
**Escopo:** validação de leads, rate limit, admin login/logout/me, cookies, CSV export injection, endpoints notes/status, seed token, trust proxy, migrations Postgres, vazamento de mensagens de erro, testes.

## 1. Estado git inicial

- Branch `main`, working tree limpo, sincronizado com `origin/main`.
- HEAD: `920bcbe fix: trust proxy default 1 (Caddy em container vizinho) + patch deps moderadas (#7)`.
- Observação: `git` emitiu `warning: unable to unlink .git/index.lock: Operation not permitted` (quirk FUSE no Cowork). Nenhum comando git mutador foi executado.

## 2. Achados por severidade

### Crítico
Nenhum.

### Alto

- **A1 — CSV export vulnerável a formula injection (OWASP CSV Injection / CWE-1236).** `src/routes/admin-leads.js` (`GET /export.csv`, função `escape`, ~linha 56, antes da correção).
  Os campos `name`, `email`, `company`, `note`, `origin` vêm do **formulário público** (não-confiável). O `escape` só fazia quoting de `" , \n \r`, mas não neutralizava células iniciadas por `= + - @ \t \r`. Um lead malicioso com `name = "=HYPERLINK(\"http://evil\",\"clique\")"` ou `=cmd|...` viraria fórmula executável quando o admin abre o CSV no Excel/Google Sheets/LibreOffice → exfiltração de dados / RCE no client do admin. **Corrigido** (ver seção 3).

### Médio

- **M1 — Cursor de paginação user-supplied não validado antes do bind no Postgres.** `src/repositories/leads.repository.js` (`decodeCursor`) e `src/repositories/audit.repository.js` (`decodeCursor`), antes da correção.
  O cursor é base64 controlado pelo cliente. `decodeCursor` decodificava `"<iso>|<id>"` e passava `new Date(iso)` e `id` direto pro bind `($n,$n)` de `(created_at, id) < (...)`. Um cursor com data inválida (`Invalid Date`) ou `id` não-UUID fazia o `pg` lançar erro de bind → **500 internal_error** em vez de tratar como cursor inválido (ignorar). Não é SQLi (parametrizado), mas é DoS leve / erro 500 trivial de disparar. **Corrigido**.

### Baixo

- **B1 — `clientIp` redundante com trust proxy.** `src/http.js:13`. `req.ip` já resolve via `trust proxy`; o fallback `x-real-ip` é spoofável se chegasse a ser usado, mas como `req.ip` quase sempre existe atrás do Caddy, é dead-ish code. Sem risco real. Não alterado.

- **B2 — `SeedAdminSchema` definido mas não usado.** `src/schemas/auth.js:11`. O `admin-seed.js` valida email com regex inline em vez do schema Zod exportado. Inconsistência menor (o regex inline funciona). Schema morto — candidato a uso ou remoção. Não alterado (decisão de design).

- **B3 — `idempotencyRepo.cleanupExpired` nunca é chamado.** `src/repositories/idempotency.repository.js:41`. O comentário diz "cleanup lazy chamado pela seed/migrate" mas nenhum caller existe. Tabela `idempotency_keys` cresce indefinidamente (TTL só é respeitado na leitura via `expires_at > NOW()`, não há GC). Baixo impacto operacional (linhas pequenas), mas vaza espaço. Documentado para Codex.

- **B4 — `password` em texto puro vai como `argv` no `seed-admin.js`.** Visível em `ps`/histórico de shell no container. É CLI de operador, comportamento conhecido (comentado no próprio arquivo). Aceitável. Não alterado.

- **B5 — mensagem de erro de `ServiceError`/`AuthError` retorna `err.message` em 4xx.** `src/middleware/errorHandler.js:35-40`. As mensagens são em português e controladas (não vazam stack nem internals). 5xx já é mascarado em produção (linha 47). OK — sem vazamento sensível. Não alterado.

## 3. Correções aplicadas

1. **A1 — anti CSV formula injection** (`src/routes/admin-leads.js`).
   `escape()` agora prefixa apóstrofo (`'`) em qualquer célula iniciada por `= + - @ \t \r` antes do quoting, neutralizando a fórmula (Excel/Sheets tratam como texto literal). Padrão OWASP.

2. **M1 — validação de cursor** (`leads.repository.js` e `audit.repository.js`).
   `decodeCursor` agora valida que a data parseada é válida (`!Number.isNaN(getTime())`) e que o `id` casa com regex UUID. Cursor malformado retorna `null` (tratado como "sem cursor") em vez de estourar 500 no bind do pg.

3. **Teste estagnado corrigido** (`tests/server.smoke.test.mjs`).
   O teste `CI workflow publica em ghcr.io/...` assertava `tags: ['v*.*.*']`, trigger que foi **removido deliberadamente** no commit `db1bc71 "ci: pause automatic actions"` (workflow agora é `workflow_dispatch`). Asserção realinhada com a config atual (`workflow_dispatch:` + `type=semver,pattern={{version}}`). Não é mudança de comportamento — é o teste acompanhando a decisão já tomada.

Nenhuma mudança estrutural de auth, versão ou refactor amplo.

## 4. Comandos / testes rodados

- `npm ci --no-audit --no-fund` → 116 pacotes, OK.
- `npm test` → inicialmente **21 pass / 1 fail** (o teste estagnado descrito acima). Após correção: **22 pass / 0 fail**.
- `npm audit --omit=dev` → **found 0 vulnerabilities**.

Testes não exigem DB (smoke estático + unit de schemas/scoring puros). Nada precisou ser pulado por DB indisponível.

## 5. Riscos restantes / itens para Codex / itens que exigem autorização do André

- **Para Codex (B3):** implementar GC de `idempotency_keys` — chamar `cleanupExpired()` no `migrate.js` (no fim) ou criar job cron, senão a tabela cresce sem limite. Fix pequeno mas exige decidir o gatilho.
- **Para Codex (B2):** usar `SeedAdminSchema` no `admin-seed.js` (substituir regex inline por `validateBody`) ou remover o schema morto.
- **Para o André:** confirmar que `cover`/url externas não se aplicam aqui (rivus não tem posts; N/A). Sem ação.
- **Lockout:** account lockout (5 falhas / 15 min) está implementado corretamente no rivus via `recordFailedLogin` + trigger SQL. Bom. Sem ação.
- **Trust proxy:** default `1` correto para Caddy-em-container. CSV/cookies/CORS com `credentials: true` + allow-list OK.
- **Migrations Postgres:** idempotentes, triggers de score/status-history/updated_at corretos. `set_config('app.current_user_id', ..., true)` dentro de transação para o trigger de history pegar o autor — implementado corretamente. Sem ação.
- **Cookies:** `httpOnly + sameSite=lax + secure(prod)` corretos. Nota menor: `setSessionCookie` no rivus usa `maxAge` fixo de 30d (não derivado de `TOKEN_TTL` como no blog-api); se mudarem `TOKEN_TTL`, o cookie pode sobreviver ao JWT. Consistência desejável mas não é bug ativo (default é 30d em ambos). Documentado.
