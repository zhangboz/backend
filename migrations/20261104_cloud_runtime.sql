CREATE TABLE IF NOT EXISTS oauth_sessions (
  sid text PRIMARY KEY,
  sess jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_sessions_expires_at_idx ON oauth_sessions (expires_at);

-- Additive runtime tables only. Do not use historical SQL snapshots to migrate.
-- Export documents are temporary and bounded by application quotas. No source
-- Markdown is stored in this table; provider resources are deleted separately.
CREATE TABLE IF NOT EXISTS export_jobs (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  format text NOT NULL CHECK (format IN ('pdf', 'docx')),
  state text NOT NULL CHECK (state IN ('starting', 'processing', 'completed', 'failed', 'expired')),
  response_id text,
  source_file_id text,
  container_id text,
  provider_file_id text,
  filename text UNIQUE,
  content bytea,
  error_code text,
  request_key text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  download_expires_at timestamptz,
  poll_after timestamptz,
  poll_token uuid,
  UNIQUE (user_id, request_key),
  CHECK (content IS NULL OR octet_length(content) <= 8388608)
);
CREATE INDEX IF NOT EXISTS export_jobs_owner_created_idx ON export_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS export_jobs_expiration_idx ON export_jobs (expires_at);
CREATE INDEX IF NOT EXISTS export_jobs_pending_idx ON export_jobs (state, poll_after)
  WHERE state IN ('starting', 'processing');
