CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lead_name TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  whatsapp_digits TEXT NOT NULL,
  interest TEXT NOT NULL,
  down_payment_range TEXT,
  down_payment_value INTEGER,
  requested_credit_range TEXT,
  requested_credit_value INTEGER,
  source_url TEXT,
  referrer TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  crm_status TEXT NOT NULL DEFAULT 'pending',
  crm_attempts INTEGER NOT NULL DEFAULT 0,
  crm_last_attempt_at TEXT,
  crm_last_error TEXT,
  crm_external_id TEXT,
  raw_payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS leads_whatsapp_digits_idx ON leads (whatsapp_digits);
CREATE INDEX IF NOT EXISTS leads_interest_idx ON leads (interest);
CREATE INDEX IF NOT EXISTS leads_crm_status_idx ON leads (crm_status, created_at);
