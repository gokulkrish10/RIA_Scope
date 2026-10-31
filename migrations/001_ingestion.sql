CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  adapter_key TEXT NOT NULL,
  options_json TEXT NOT NULL CHECK(json_valid(options_json))
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('monitor', 'ingestion')),
  state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 5),
  available_at INTEGER NOT NULL,
  lease_until INTEGER,
  claim_token TEXT,
  stage TEXT NOT NULL DEFAULT 'queued'
) STRICT;
CREATE INDEX jobs_ready ON jobs(state, available_at, lease_until);

CREATE TABLE monitoring_runs (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))
) STRICT;
CREATE TABLE monitoring_run_sources (
  job_id TEXT NOT NULL REFERENCES monitoring_runs(job_id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_snapshot_json TEXT NOT NULL CHECK(json_valid(source_snapshot_json)),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  PRIMARY KEY(job_id, source_id)
) STRICT;
-- Held until the entire monitor job is terminal. Overlapping manual/scheduled runs conflict.
CREATE TABLE source_locks (
  source_id TEXT PRIMARY KEY REFERENCES sources(id),
  job_id TEXT NOT NULL REFERENCES jobs(id)
) STRICT;

CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  canonical_key TEXT NOT NULL,
  document_id TEXT NOT NULL UNIQUE,
  current_version_id TEXT REFERENCES document_versions(id) DEFERRABLE INITIALLY DEFERRED,
  discovery_json TEXT NOT NULL CHECK(json_valid(discovery_json)),
  review_json TEXT NOT NULL CHECK(json_valid(review_json)),
  updated_at TEXT NOT NULL,
  UNIQUE(source_id, canonical_key)
) STRICT;
CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES publications(id),
  version_number INTEGER NOT NULL CHECK(version_number > 0),
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
  original_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  extracted_text TEXT,
  extracted_pages_json TEXT CHECK(extracted_pages_json IS NULL OR json_valid(extracted_pages_json)),
  UNIQUE(publication_id, version_number),
  UNIQUE(publication_id, content_hash)
) STRICT;
CREATE TABLE ingestion_tasks (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  version_id TEXT NOT NULL REFERENCES document_versions(id)
) STRICT;
CREATE INDEX ingestion_version ON ingestion_tasks(version_id);
CREATE TABLE job_events (
  sequence INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  at TEXT NOT NULL,
  stage TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json))
) STRICT;
