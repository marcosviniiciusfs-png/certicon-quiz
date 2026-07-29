ALTER TABLE leads ADD COLUMN meta_event_id TEXT;
ALTER TABLE leads ADD COLUMN meta_capi_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE leads ADD COLUMN meta_capi_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN meta_capi_sent_at TEXT;
ALTER TABLE leads ADD COLUMN meta_capi_response TEXT;
ALTER TABLE leads ADD COLUMN meta_capi_error TEXT;

CREATE INDEX IF NOT EXISTS leads_meta_capi_status_idx
  ON leads (meta_capi_status, created_at);
