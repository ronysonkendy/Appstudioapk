CREATE TABLE IF NOT EXISTS backup_files (
  rel_path TEXT PRIMARY KEY,
  parts INT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  urls JSONB NOT NULL,
  public_ids JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
