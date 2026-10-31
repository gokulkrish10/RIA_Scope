-- Additive only: ingestion tables and their data are not rebuilt or modified.
CREATE TABLE version_analysis (
  version_id TEXT PRIMARY KEY REFERENCES document_versions(id),
  model_identity TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','processing','succeeded','failed')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  public_json TEXT CHECK(public_json IS NULL OR json_valid(public_json)),
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE analysis_chunks (
  cache_key TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  result_json TEXT NOT NULL CHECK(json_valid(result_json))
) STRICT;
CREATE TABLE analysis_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('ingestion','comparison')),
  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','blocked')),
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  claim_token TEXT,
  lease_until INTEGER,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))
) STRICT;
CREATE INDEX analysis_jobs_ready ON analysis_jobs(state,available_at,lease_until);
CREATE UNIQUE INDEX active_analysis_version ON analysis_jobs(version_id) WHERE kind='ingestion' AND state IN ('queued','running');
CREATE UNIQUE INDEX active_comparison_version ON analysis_jobs(version_id) WHERE kind='comparison' AND state IN ('queued','running');
CREATE TABLE analysis_job_events (
  sequence INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES analysis_jobs(id),
  at TEXT NOT NULL,
  stage TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json))
) STRICT;
CREATE TABLE comparisons (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES analysis_jobs(id),
  publication_id TEXT NOT NULL REFERENCES publications(id),
  current_version_id TEXT NOT NULL REFERENCES document_versions(id),
  predecessor_version_id TEXT REFERENCES document_versions(id),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  diff_json TEXT CHECK(diff_json IS NULL OR json_valid(diff_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE predecessor_links (
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  reference_id TEXT NOT NULL,
  predecessor_version_id TEXT NOT NULL REFERENCES document_versions(id),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  linked_at TEXT NOT NULL,
  PRIMARY KEY(version_id, reference_id)
) STRICT;
