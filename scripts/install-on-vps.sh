#!/bin/bash
# ============================================================================
# install-on-vps.sh — instala/repara Rivus API direto na VPS principal.
#
# Idempotente: detecta o que já existe e completa só o que falta. Pode rodar
# múltiplas vezes sem efeito colateral.
#
# Pré-requisitos:
#   - Tenant rivus já cadastrado no painel (com VPS apontando pra 195.200.4.22)
#   - /opt/clients/rivus/docker-compose.yml já existe (postgres do Rivus)
#   - /opt/gateway/Caddyfile já tem bloco do rivus.trading (deploy do site
#     Lovable do Rivus já rolou — `nginx-rivus` rodando)
#
# Uso (no terminal do Mac):
#
#   source ~/.config/artificialis/vps-creds && \
#     curl -sL https://raw.githubusercontent.com/artificialislab/client-rivus-api/main/scripts/install-on-vps.sh | \
#     ADMIN_EMAIL=contato@rivus.trading \
#     python3 ~/Documents/ArtificialisLab/.dev-tools/vps_ssh.py --stdin
#
# Variáveis opcionais (export antes do comando):
#   ADMIN_EMAIL     — email do admin a criar (default: contato@rivus.trading)
#   ADMIN_PASSWORD  — senha do admin (default: gerada aleatória, mostrada no fim)
#   RIVUS_API_TAG   — tag da imagem Docker (default: 1.1.0)
# ============================================================================

set -euo pipefail

CLIENT_DIR="/opt/clients/rivus"
PREFIX="rivus"
RIVUS_API_TAG="${RIVUS_API_TAG:-1.1.0}"
ADMIN_EMAIL="${ADMIN_EMAIL:-contato@rivus.trading}"
# Senha forte aleatória se não passada (24 chars base64url)
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(openssl rand -base64 24 | tr '+/' '-_' | head -c 24)}"

CADDYFILE="/opt/gateway/Caddyfile"
GATEWAY_CONTAINER="gateway-caddy"

# ─── Helpers ─────────────────────────────────────────────────────────────
log()  { echo "[install-rivus-api] $*"; }
die()  { echo "[install-rivus-api] ERRO: $*" >&2; exit 1; }
exists() { [ -e "$1" ]; }
container_running() { docker ps --filter "name=^/$1\$" --format '{{.Names}}' | grep -qx "$1"; }

# ─── Pré-flight ─────────────────────────────────────────────────────────
log "1/9  Validando pré-requisitos..."
[ -d "$CLIENT_DIR" ] || die "$CLIENT_DIR não existe — Rivus precisa ter postgres instalado primeiro (via Install Service)"
[ -f "$CLIENT_DIR/docker-compose.yml" ] || die "docker-compose.yml ausente em $CLIENT_DIR"
[ -f "$CLIENT_DIR/.env" ] || die ".env ausente em $CLIENT_DIR"
container_running "${PREFIX}-postgres" || die "Container ${PREFIX}-postgres não está rodando"
[ -f "$CADDYFILE" ] || die "$CADDYFILE não existe"
container_running "$GATEWAY_CONTAINER" || die "$GATEWAY_CONTAINER não está rodando"
log "   ok"

cd "$CLIENT_DIR"

# ─── 2. Secrets ─────────────────────────────────────────────────────────
log "2/9  Garantindo RIVUS_JWT_SECRET, RIVUS_SEED_TOKEN, RIVUS_API_PORT no .env..."
EXISTING_JWT=$(grep -E '^RIVUS_JWT_SECRET=' .env | cut -d= -f2- || true)
EXISTING_SEED=$(grep -E '^RIVUS_SEED_TOKEN=' .env | cut -d= -f2- || true)

if [ -z "$EXISTING_JWT" ]; then
  echo "RIVUS_JWT_SECRET=$(openssl rand -hex 48)" >> .env
  log "   RIVUS_JWT_SECRET gerado"
fi
if [ -z "$EXISTING_SEED" ]; then
  echo "RIVUS_SEED_TOKEN=$(openssl rand -hex 48)" >> .env
  log "   RIVUS_SEED_TOKEN gerado"
fi
grep -q '^RIVUS_API_PORT=' .env || echo 'RIVUS_API_PORT=3902' >> .env
grep -q '^RIVUS_CORS_ORIGINS=' .env || echo 'RIVUS_CORS_ORIGINS=https://rivus.trading,https://www.rivus.trading' >> .env

# ─── 3. Bloco compose ────────────────────────────────────────────────────
log "3/9  Garantindo bloco rivus-api no docker-compose.yml..."
if grep -q 'container_name: rivus-rivus-api' docker-compose.yml; then
  log "   já presente — só atualiza imagem se preciso"
  # Atualiza a tag in-place
  sed -i "s|image: ghcr.io/artificialislab/rivus-api:[^[:space:]]*|image: ghcr.io/artificialislab/rivus-api:${RIVUS_API_TAG}|g" docker-compose.yml
else
  cat >> docker-compose.yml <<COMPOSE_EOF

  rivus-api:
    image: ghcr.io/artificialislab/rivus-api:${RIVUS_API_TAG}
    container_name: rivus-rivus-api
    restart: unless-stopped
    ports:
      - "127.0.0.1:\${RIVUS_API_PORT:-3902}:3001"
    environment:
      - DATABASE_URL=postgresql://rivus:\${POSTGRES_PASSWORD}@postgres:5432/rivus_rivus
      - RIVUS_JWT_SECRET=\${RIVUS_JWT_SECRET}
      - RIVUS_SEED_TOKEN=\${RIVUS_SEED_TOKEN}
      - PORT=3001
      - COOKIE_NAME=rivus_rivus_session
      - TOKEN_TTL=30d
      - RIVUS_CORS_ORIGINS=\${RIVUS_CORS_ORIGINS:-https://rivus.trading}
      - RIVUS_API_VERSION=${RIVUS_API_TAG}
      - TZ=America/Sao_Paulo
    depends_on:
      postgres:
        condition: service_healthy
    networks:
      - rivus-net
    healthcheck:
      test: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3001/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))\""]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
COMPOSE_EOF
  log "   bloco adicionado"
fi

# ─── 4. DB ──────────────────────────────────────────────────────────────
log "4/9  Garantindo DB rivus_rivus..."
EXISTS=$(docker exec rivus-postgres psql -U rivus -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='rivus_rivus'" 2>/dev/null || echo "")
if [ "$EXISTS" = "1" ]; then
  log "   já existe"
else
  docker exec rivus-postgres psql -U rivus -d postgres -c 'CREATE DATABASE rivus_rivus OWNER rivus' >/dev/null
  log "   criado"
fi

# ─── 5. Pull + up ───────────────────────────────────────────────────────
log "5/9  Pull image + docker compose up -d rivus-api..."
docker compose pull rivus-api 2>&1 | tail -3
docker compose up -d rivus-api 2>&1 | tail -3

# ─── 6. Healthcheck ─────────────────────────────────────────────────────
log "6/9  Aguardando rivus-api healthy (até 60s)..."
HEALTHY=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if docker exec rivus-rivus-api node -e "fetch('http://127.0.0.1:3001/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))" 2>/dev/null; then
    HEALTHY=1; log "   healthy (tentativa $i)"; break
  fi
  sleep 5
done
[ "$HEALTHY" = "1" ] || { docker compose logs --tail=50 rivus-api; die "rivus-api não ficou healthy em 60s"; }

# ─── 7. Seed admin ──────────────────────────────────────────────────────
log "7/9  Seeding admin ($ADMIN_EMAIL)..."
docker exec rivus-rivus-api node src/seed-admin.js "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "Admin Rivus" 2>&1 | tail -3

# ─── 8. Caddy /api/* handle ─────────────────────────────────────────────
log "8/9  Adicionando handle /api/* → 127.0.0.1:3902 no Caddyfile..."
if grep -A 20 'rivus\.trading' "$CADDYFILE" | grep -q '127.0.0.1:3902'; then
  log "   handle já presente — skip"
else
  cp "$CADDYFILE" "${CADDYFILE}.bak.$(date +%s)"
  python3 - <<'PY_EOF'
import re

CADDYFILE = '/opt/gateway/Caddyfile'
with open(CADDYFILE, 'r') as f:
    content = f.read()

# Casos possíveis no bloco do rivus.trading:
#   (1) reverse_proxy simples direto → tem que virar triple-handle
#   (2) já tem handle blocks → adiciona /api/* na frente
# Detecta pelo bloco "# ── Website: rivus" se existir.

block_re = re.compile(
    r'(# ── Website: rivus[^\n]*\n[^{]*\{)(.*?)(\n\})',
    re.DOTALL,
)
m = block_re.search(content)
if not m:
    # Fallback: busca por "rivus.trading {" diretamente
    block_re = re.compile(
        r'(rivus\.trading[^{]*\{)(.*?)(\n\})',
        re.DOTALL,
    )
    m = block_re.search(content)

if not m:
    raise SystemExit('ERRO: bloco do rivus.trading não encontrado no Caddyfile')

header, body, footer = m.group(1), m.group(2), m.group(3)

# Se já tem handle /api/*, não duplica
if 'handle /api/*' in body or 'handle_path /api/*' in body:
    print('   handle /api/* já existe no bloco — nada a fazer')
    raise SystemExit(0)

# Extrai a porta do nginx do site (último reverse_proxy 127.0.0.1:NNNN)
nginx_ports = re.findall(r'reverse_proxy\s+127\.0\.0\.1:(\d+)', body)
nginx_port = nginx_ports[-1] if nginx_ports else None
if not nginx_port:
    raise SystemExit('ERRO: porta do nginx do rivus não detectada no bloco')

# Reescreve bloco com triple-handle (preserva imports/encode existentes)
extras = []
for line in body.split('\n'):
    if 'reverse_proxy' in line:
        continue  # vai virar handle bloco abaixo
    extras.append(line)
extras_text = '\n'.join(line for line in extras if line.strip())

new_body = (
    '\n  handle /api/* {\n'
    '    reverse_proxy 127.0.0.1:3902\n'
    '  }\n'
    '  handle {\n'
    f'    reverse_proxy 127.0.0.1:{nginx_port}\n'
    '  }\n'
    + ('  ' + extras_text.strip().replace('\n', '\n  ') + '\n' if extras_text.strip() else '')
)
new_block = header + new_body + footer

new_content = content.replace(m.group(0), new_block)
with open(CADDYFILE, 'w') as f:
    f.write(new_content)
print('   handle /api/* + handle default injetados (nginx :' + nginx_port + ')')
PY_EOF
fi

# ─── 9. Validate + reload ──────────────────────────────────────────────
log "9/9  Validate + reload Caddy..."
docker exec "$GATEWAY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -3
docker exec "$GATEWAY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile 2>&1 | tail -3

# Atualiza tenants.install_services no DB do backend principal pra
# refletir que rivus-api tá instalada (idempotente).
log "   atualizando tenants.install_services no backend principal..."
PGPASSWORD="${POSTGRES_PASSWORD_BACKEND:-}" psql -h localhost -p 5432 -U artificialis -d artificialis_platform \
  -c "UPDATE tenants SET install_services = COALESCE(install_services, '[]'::jsonb) || '[\"rivus-api\"]'::jsonb WHERE slug = 'rivus' AND NOT (install_services ?? 'rivus-api')" 2>/dev/null \
  || log "   (skip atualização DB — sem PGPASSWORD_BACKEND, não bloqueia install)"

# ─── Smoke ──────────────────────────────────────────────────────────────
log ""
log "Smoke test externo:"
sleep 3
SMOKE=$(curl -sf -m 10 https://rivus.trading/api/health 2>&1 || echo "FAIL")
log "  $SMOKE"

echo ""
echo "============================================================"
echo "  ✓ Rivus API instalada"
echo "============================================================"
echo "  URL:    https://rivus.trading/api/health"
echo "  Login:  https://rivus.trading/admin/login"
echo "  Email:  $ADMIN_EMAIL"
echo "  Senha:  $ADMIN_PASSWORD"
echo "============================================================"
echo "  Guarde a senha — não será exibida novamente."
echo "  Pra resetar: docker exec rivus-rivus-api node src/seed-admin.js <email> <novasenha>"
echo "============================================================"
