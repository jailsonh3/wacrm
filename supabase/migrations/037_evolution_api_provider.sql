-- ============================================================
-- 037_evolution_api_provider.sql — Evolution API integration
--
-- Adds support for Evolution API as an alternative WhatsApp provider.
-- The existing Meta Business API integration remains unchanged.
-- ============================================================

-- Provider enum: 'meta' (default) or 'evolution'
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
  CHECK (provider IN ('meta', 'evolution'));

-- Evolution API specific columns
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_instance_name TEXT,
  ADD COLUMN IF NOT EXISTS evolution_api_url TEXT,
  ADD COLUMN IF NOT EXISTS evolution_api_key TEXT; -- encrypted with ENCRYPTION_KEY

-- Index for provider-based queries
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_provider ON whatsapp_config(provider);
