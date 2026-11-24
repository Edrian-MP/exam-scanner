BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE exam_scanner.online_scan_jobs
    ADD COLUMN IF NOT EXISTS activity text
        CHECK (activity IN ('connecting_feeder', 'feeding', 'scanning', 'processing')),
    ADD COLUMN IF NOT EXISTS feed_attempt smallint
        CHECK (feed_attempt BETWEEN 1 AND 3);

COMMIT;
