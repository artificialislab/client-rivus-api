-- ============================================================================
-- Migration 003 — idempotency claim-first
--
-- A linha da Idempotency-Key passa a ser inserida ANTES do processamento
-- (claim) e a response preenchida DEPOIS via UPDATE. Elimina a janela do
-- padrão antigo resolve()/record() em que dois POSTs simultâneos com a
-- mesma key criavam dois leads. Linha sem response = request em andamento
-- (API responde 409 request_in_progress).
--
-- Idempotente — pode rodar em DBs com dados existentes sem perder nada.
-- ============================================================================

ALTER TABLE idempotency_keys ALTER COLUMN response_status DROP NOT NULL;
ALTER TABLE idempotency_keys ALTER COLUMN response_body   DROP NOT NULL;
