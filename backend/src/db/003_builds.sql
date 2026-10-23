CREATE TABLE IF NOT EXISTS builds (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INT NOT NULL,
  status TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT false,
  file_name TEXT,
  stored_name TEXT,
  size_bytes BIGINT,
  sha256 TEXT,
  signer_sha256 TEXT,
  changes_count INT NOT NULL DEFAULT 0,
  log TEXT NOT NULL DEFAULT '',
  error TEXT,
  download_token TEXT UNIQUE,
  expires_at TIMESTAMPTZ,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS builds_project_idx ON builds(project_id, created_at DESC);
