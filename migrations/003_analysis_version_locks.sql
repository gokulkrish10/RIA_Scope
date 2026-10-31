-- Prevent two jobs (for example ingestion analysis and comparison) from analysing
-- the same immutable version concurrently. Ownership follows the existing job lease.
CREATE TABLE analysis_version_locks (
  version_id TEXT PRIMARY KEY REFERENCES document_versions(id),
  job_id TEXT NOT NULL REFERENCES analysis_jobs(id),
  claim_token TEXT NOT NULL
) STRICT;
