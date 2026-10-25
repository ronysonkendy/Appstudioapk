CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT 'local',
  name TEXT NOT NULL,
  package_name TEXT,
  version_name TEXT,
  version_code TEXT,
  min_sdk INT,
  target_sdk INT,
  status TEXT NOT NULL DEFAULT 'analyzed',
  original_path TEXT NOT NULL,
  original_sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  info JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_id);
