-- ============================================================================
-- Rivus API — schema inicial
--
-- Idempotente (CREATE TABLE IF NOT EXISTS, etc.) — pode rodar várias vezes
-- sem efeito colateral. Aplicado pelo src/migrate.js no startup do container.
--
-- Tabelas:
--   admin_users           — operadores internos do painel /admin
--   early_access_leads    — leads do formulário público (Lovable)
--   lead_notes            — notas internas timeline por lead
-- ============================================================================

-- pgcrypto pra gen_random_uuid() (vem por padrão no postgres:17-alpine
-- mas garantimos com IF NOT EXISTS — barato).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── admin_users ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  name            TEXT,
  role            TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator')),
  password_hash   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ
);

-- Email case-insensitive unique. lower() index permite query rápida no auth.js.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_email_lower
  ON admin_users (LOWER(email));

-- ─── early_access_leads ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS early_access_leads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference     TEXT NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  company       TEXT NOT NULL,
  phone         TEXT NOT NULL,
  profile       TEXT NOT NULL CHECK (profile IN ('buyer', 'seller', 'both')),
  volume_band   TEXT NOT NULL CHECK (volume_band IN ('lt_500k', '500k_2m', '2m_10m', '10m_50m', 'gt_50m')),
  origin        TEXT,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'rejected', 'converted')),
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_reference ON early_access_leads (reference);
CREATE INDEX IF NOT EXISTS idx_leads_status ON early_access_leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_email_lower ON early_access_leads (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_leads_created_desc ON early_access_leads (created_at DESC);

-- updated_at trigger — mantém timestamp em sincronia automaticamente.
CREATE OR REPLACE FUNCTION early_access_leads_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_leads_updated_at ON early_access_leads;
CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON early_access_leads
  FOR EACH ROW EXECUTE FUNCTION early_access_leads_set_updated_at();

-- ─── lead_notes ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lead_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID NOT NULL REFERENCES early_access_leads(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notes_lead_created ON lead_notes (lead_id, created_at DESC);
