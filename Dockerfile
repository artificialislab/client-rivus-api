# ============================================================================
# Rivus API — imagem Docker provisionada via plataforma Artificialis.
#
# Padrão idêntico ao core-blog-api: Node 20 alpine, production only,
# migrations idempotentes no startup. Customizável só nas env vars.
# ============================================================================
FROM node:20-alpine

ARG RIVUS_API_VERSION=dev

ENV NODE_ENV=production \
    RIVUS_API_VERSION=$RIVUS_API_VERSION

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY db ./db

# Porta interna. Caddy faz reverse_proxy /api/* aqui no host do tenant.
EXPOSE 3001

# Healthcheck — bate em /ready, retorna 503 se DB/migrations estiverem indisponíveis.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/ready').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# migrate.js é idempotente. Falha aqui = container não sobe (intencional).
CMD ["sh", "-c", "node src/migrate.js && node src/server.js"]
