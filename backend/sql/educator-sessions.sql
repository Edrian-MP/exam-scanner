BEGIN;
SET LOCAL search_path = exam_scanner, pg_catalog;

ALTER TABLE exams ADD COLUMN educator_id integer REFERENCES educators(id) ON DELETE CASCADE;
CREATE INDEX exams_educator_id_idx ON exams (educator_id);

ALTER TABLE students ADD COLUMN educator_id integer REFERENCES educators(id) ON DELETE CASCADE;
ALTER TABLE students DROP CONSTRAINT students_student_code_key;
ALTER TABLE students ADD UNIQUE (educator_id, student_code);
CREATE UNIQUE INDEX students_unassigned_code_idx ON students (student_code) WHERE educator_id IS NULL;

-- Assign records when their existing subject links identify a single owner.
UPDATE exams AS e SET educator_id = owners.educator_id
FROM (
    SELECT a.exam_id, min(s.educator_id) AS educator_id
    FROM subject_activities a JOIN subjects s ON s.id = a.subject_id
    WHERE a.exam_id IS NOT NULL
    GROUP BY a.exam_id HAVING count(DISTINCT s.educator_id) = 1
) owners WHERE owners.exam_id = e.id;

UPDATE students AS st SET educator_id = owners.educator_id
FROM (
    SELECT ss.student_id, min(s.educator_id) AS educator_id
    FROM subject_students ss JOIN subjects s ON s.id = ss.subject_id
    GROUP BY ss.student_id HAVING count(DISTINCT s.educator_id) = 1
) owners WHERE owners.student_id = st.id;

-- This also preserves standalone records from a single-educator deployment.
UPDATE exams SET educator_id = (SELECT min(id) FROM educators)
WHERE educator_id IS NULL AND (SELECT count(*) FROM educators) = 1;
UPDATE students SET educator_id = (SELECT min(id) FROM educators)
WHERE educator_id IS NULL AND (SELECT count(*) FROM educators) = 1;

CREATE TABLE educator_sessions (
    token_hash char(64) PRIMARY KEY,
    educator_id integer NOT NULL REFERENCES educators(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX educator_sessions_educator_id_idx ON educator_sessions (educator_id);
CREATE INDEX educator_sessions_expires_at_idx ON educator_sessions (expires_at);

CREATE TABLE educator_auth_attempts (
    subject_hash char(64) NOT NULL,
    bucket bigint NOT NULL,
    attempts integer NOT NULL DEFAULT 1,
    PRIMARY KEY (subject_hash, bucket)
);
CREATE INDEX educator_auth_attempts_bucket_idx ON educator_auth_attempts (bucket);

CREATE TABLE scan_sessions (
    id varchar(36) PRIMARY KEY,
    educator_id integer NOT NULL REFERENCES educators(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX scan_sessions_educator_id_idx ON scan_sessions (educator_id);

GRANT SELECT, INSERT, DELETE ON educator_sessions, scan_sessions TO exam_scanner_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON educator_auth_attempts TO exam_scanner_app;

COMMIT;
