BEGIN;
SET LOCAL search_path = exam_scanner, pg_catalog;

CREATE TABLE online_scanners (
    educator_id integer PRIMARY KEY REFERENCES educators(id) ON DELETE CASCADE,
    token_hash char(64) NOT NULL UNIQUE,
    worker_id varchar(32),
    last_seen_at timestamptz,
    scanner_ready boolean NOT NULL DEFAULT false,
    arduino_ready boolean NOT NULL DEFAULT false
);

CREATE TABLE online_scan_jobs (
    session_id varchar(36) PRIMARY KEY REFERENCES scan_sessions(id) ON DELETE CASCADE,
    educator_id integer NOT NULL REFERENCES online_scanners(educator_id) ON DELETE CASCADE,
    single_sheet boolean NOT NULL,
    phase text NOT NULL CHECK (phase IN ('queued', 'scanning', 'stopping', 'finished')),
    waiting_for_paper boolean NOT NULL DEFAULT false,
    finish_reason text,
    finish_message text,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX online_scan_jobs_one_active_idx ON online_scan_jobs (educator_id)
    WHERE phase <> 'finished';
CREATE INDEX online_scan_jobs_recent_idx ON online_scan_jobs (educator_id, created_at DESC);

ALTER TABLE online_scanners ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_scan_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY backend_online_scanners ON online_scanners TO exam_scanner_app USING (true) WITH CHECK (true);
CREATE POLICY backend_online_scan_jobs ON online_scan_jobs TO exam_scanner_app USING (true) WITH CHECK (true);
REVOKE ALL ON online_scanners, online_scan_jobs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON online_scanners, online_scan_jobs TO exam_scanner_app;

COMMIT;
