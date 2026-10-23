ALTER TABLE projects ADD COLUMN IF NOT EXISTS decode_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS decode_error TEXT;

CREATE TABLE IF NOT EXISTS decode_edits (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, path)
);
