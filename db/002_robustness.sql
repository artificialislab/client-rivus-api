-- ============================================================================
-- Rivus API — robustness migration (v1.1)
--
-- Adiciona camadas de produção: soft delete, audit trail, tracking de
-- origem (UTM), lead scoring automático, status history, idempotency,
-- account lockout. Tudo idempotente — pode rodar em DBs com dados
-- existentes sem perder nada.
-- ============================================================================

-- ─── early_access_leads — extensões ──────────────────────────────────────
ALTER TABLE early_access_leads ADD COLUMN IF NOT EXISTS deleted_at     TIMESTAMPTZ;
ALTER TABLE early_access_leads ADD COLUMN IF NOT EXISTS tags           TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE early_access_leads ADD COLUMN IF NOT EXISTS utm_source     TEXT;
ALTER TABLE early_access_leads ADD COLUMN IF NOT EXISTS utm_medium     TEXT;
ALTER TABLE early_access_leads ADD COLUMN IF NOT EXISTS utm_campaign   TEXT;
ALTER TABLE early_access_leads ADD COLUMN IF NOT EXISTS referrer       TEXT;
ALTER TABLE early_access_leads ADD COLUMN IF NOT EXISTS lead_score     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE early_access_leads ADD COLUMN IF NOT EXISTS assigned_to    UUID REFERENCES admin_users(id) ON DELETE SET NULL;

-- Índice pra queries que filtram só não-deletados (90%+ dos casos)
CREATE INDEX IF NOT EXISTS idx_leads_active_created
  ON early_access_leads (created_at DESC)
  WHERE deleted_at IS NULL;

-- Índice composto pra filtro por status + ordem (hot path do admin)
CREATE INDEX IF NOT EXISTS idx_leads_status_created
  ON early_access_leads (status, created_at DESC)
  WHERE deleted_at IS NULL;

-- Índice GIN pra busca por tags (ex: WHERE tags && ARRAY['high-value'])
CREATE INDEX IF NOT EXISTS idx_leads_tags_gin
  ON early_access_leads USING GIN (tags);

-- ─── admin_users — lockout + tracking ────────────────────────────────────
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS failed_attempts  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS locked_until     TIMESTAMPTZ;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS last_failed_at   TIMESTAMPTZ;

-- ─── lead_status_history — timeline ─────────────────────────────────────
-- Cada mudança de status gera 1 row. Trigger automático abaixo.
-- Permite renderizar timeline ("status_change · há 2h por João: contato OK")
CREATE TABLE IF NOT EXISTS lead_status_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID NOT NULL REFERENCES early_access_leads(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  author_id   UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_status_history_lead_created
  ON lead_status_history (lead_id, created_at DESC);

-- Trigger que registra automaticamente toda mudança de status.
-- O author_id vem da session var `app.current_user_id` que o service seta
-- no início de cada request autenticado (set_config). Se ausente, autor = null.
CREATE OR REPLACE FUNCTION early_access_leads_log_status_change()
RETURNS TRIGGER AS $$
DECLARE
  current_user_id_text TEXT;
  current_user_id_uuid UUID;
BEGIN
  IF (NEW.status IS DISTINCT FROM OLD.status) THEN
    current_user_id_text := current_setting('app.current_user_id', true);
    BEGIN
      current_user_id_uuid := current_user_id_text::UUID;
    EXCEPTION WHEN OTHERS THEN
      current_user_id_uuid := NULL;
    END;
    INSERT INTO lead_status_history (lead_id, from_status, to_status, author_id)
    VALUES (NEW.id, OLD.status, NEW.status, current_user_id_uuid);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_leads_status_history ON early_access_leads;
CREATE TRIGGER trg_leads_status_history
  AFTER UPDATE OF status ON early_access_leads
  FOR EACH ROW EXECUTE FUNCTION early_access_leads_log_status_change();

-- ─── audit_events — log genérico de ações ───────────────────────────────
-- Append-only. Toda mutation em entidade significativa vira 1 row.
-- Útil pra: forensics, GDPR (quem viu/alterou dados), debug.
CREATE TABLE IF NOT EXISTS audit_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   TEXT,
  action       TEXT NOT NULL,           -- ex: 'lead.create', 'lead.status_change', 'admin.login_failed'
  actor_id     UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  actor_email  TEXT,                    -- snapshot p/ leitura mesmo se admin foi deletado
  entity_type  TEXT,                    -- ex: 'lead', 'note', 'admin'
  entity_id    UUID,
  changes      JSONB,                   -- diff opcional ({ before: {...}, after: {...} })
  ip           INET,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_created_desc      ON audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor_created     ON audit_events (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity_created    ON audit_events (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_created    ON audit_events (action, created_at DESC);

-- ─── idempotency_keys — dedup de POSTs ──────────────────────────────────
-- Cliente envia header `Idempotency-Key: <uuid>`; se já existe response
-- gravada pra essa key, retorna a mesma sem re-executar a operação.
-- TTL 24h (suficiente pra retries de cliente). Cleanup via cron simples.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             TEXT PRIMARY KEY,
  endpoint        TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body   JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at);

-- ─── compute_lead_score — função pura ───────────────────────────────────
-- Score 0-100 baseado em sinais de qualificação. Heurístico simples,
-- afinável depois sem migration nova (só CREATE OR REPLACE).
--
-- Pesos:
--   volume_band: lt_500k=10, 500k_2m=30, 2m_10m=55, 10m_50m=75, gt_50m=90
--   profile bonus: both=+5, seller=+3 (seller paga mais comissão)
--   completude: tem origin +3, tem note (qualif) +2
CREATE OR REPLACE FUNCTION compute_lead_score(
  p_profile      TEXT,
  p_volume_band  TEXT,
  p_origin       TEXT,
  p_note         TEXT
) RETURNS INTEGER AS $$
DECLARE
  base INTEGER;
  bonus INTEGER := 0;
BEGIN
  base := CASE p_volume_band
    WHEN 'lt_500k' THEN 10
    WHEN '500k_2m' THEN 30
    WHEN '2m_10m'  THEN 55
    WHEN '10m_50m' THEN 75
    WHEN 'gt_50m'  THEN 90
    ELSE 0
  END;
  bonus := bonus + CASE p_profile WHEN 'both' THEN 5 WHEN 'seller' THEN 3 ELSE 0 END;
  IF p_origin IS NOT NULL AND length(trim(p_origin)) > 0 THEN bonus := bonus + 3; END IF;
  IF p_note IS NOT NULL AND length(trim(p_note)) > 0 THEN bonus := bonus + 2; END IF;
  RETURN LEAST(100, base + bonus);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Trigger: calcula score automaticamente em insert + update relevante.
-- Mantém lead_score em sincronia sem o app precisar lembrar.
CREATE OR REPLACE FUNCTION early_access_leads_set_score()
RETURNS TRIGGER AS $$
BEGIN
  NEW.lead_score := compute_lead_score(NEW.profile, NEW.volume_band, NEW.origin, NEW.note);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_leads_set_score ON early_access_leads;
CREATE TRIGGER trg_leads_set_score
  BEFORE INSERT OR UPDATE OF profile, volume_band, origin, note ON early_access_leads
  FOR EACH ROW EXECUTE FUNCTION early_access_leads_set_score();

-- Backfill: recomputa lead_score pra rows existentes (idempotente).
UPDATE early_access_leads
SET lead_score = compute_lead_score(profile, volume_band, origin, note)
WHERE lead_score = 0;
