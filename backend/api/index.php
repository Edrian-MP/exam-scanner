<?php

declare(strict_types=1);

require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/http.php';
require __DIR__ . '/lib/educator_session.php';
require __DIR__ . '/lib/scanner_client.php';
require __DIR__ . '/lib/online_scanner.php';

$cfg = app_config();

header('Access-Control-Allow-Origin: ' . $cfg['cors_origin']);
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$base = str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? ''));
if ($base !== '/' && str_starts_with($path, $base)) {
    $path = substr($path, strlen($base));
}
$path = '/' . trim((string) $path, '/');
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

if (educator_sessions_required()) {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $siteOrigin = rtrim(getenv('RENDER_EXTERNAL_URL') ?: $cfg['cors_origin'], '/');
    if (!in_array($method, ['GET', 'HEAD'], true) && (
        ($origin !== '' && $origin !== $siteOrigin) || ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site'
    )) {
        json_response(403, ['ok' => false, 'error' => 'Cross-site requests are not allowed.']);
    }
    $publicRoute = ($method === 'POST' && in_array($path, ['/auth/login', '/auth/signup', '/auth/logout'], true))
        || ($method === 'GET' && $path === '/auth/session');
    if (str_starts_with($path, '/scanner/device/')) {
        online_scanner_handle_device($path, $method);
    }
    if (!$publicRoute) {
        session_educator_id();
    }
}

function normalize_answer_token(string $token): string
{
    $upper = strtoupper(trim($token));
    $upper = preg_replace('/[^A-Z]/', '', $upper) ?? '';
    return substr($upper, 0, 1);
}

function parse_answers_input(string $raw): array
{
    $raw = trim($raw);
    if ($raw === '') {
        return [];
    }

    $lines = preg_split('/[\r\n|]+/', $raw) ?: [];
    $items = [];
    foreach ($lines as $line) {
        $line = preg_replace('/^\s*\d+\s*[.)-]?\s*/', '', trim($line)) ?? '';
        $token = normalize_answer_token($line);
        if ($token !== '') {
            $items[] = $token;
        }
    }
    return $items;
}

function is_valid_answer_token(string $token): bool
{
    return (bool) preg_match('/^[A-Z]$/', $token);
}

function generate_unique_exam_code(): ?string
{
    for ($attempt = 0; $attempt < 10; $attempt++) {
        $code = str_pad((string) random_int(1, 999999), 6, '0', STR_PAD_LEFT);
        $exists = db()->prepare('SELECT id FROM subject_activities WHERE exam_code = :code LIMIT 1');
        $exists->execute([':code' => $code]);
        if (!$exists->fetch()) {
            return $code;
        }
    }
    return null;
}

function normalize_exam_code_input($value): ?string
{
    $code = trim((string) ($value ?? ''));
    if ($code === '') {
        return null;
    }
    if (!preg_match('/^[0-9]{6}$/', $code)) {
        json_response(400, ['ok' => false, 'error' => 'Exam code must be exactly 6 digits.']);
    }
    return $code;
}

function ensure_exam_code_available(string $code, ?int $excludeActivityId = null): void
{
    $sql = 'SELECT id FROM subject_activities WHERE exam_code = :code';
    $params = [':code' => $code];
    if ($excludeActivityId !== null) {
        $sql .= ' AND id <> :id';
        $params[':id'] = $excludeActivityId;
    }
    $sql .= ' LIMIT 1';

    $stmt = db()->prepare($sql);
    $stmt->execute($params);
    if ($stmt->fetch()) {
        json_response(400, ['ok' => false, 'error' => 'Exam code is already used.']);
    }
}

function normalize_answers_for_store(array $items): string
{
    return implode('|', $items);
}

function ensure_student_code_schema(): void
{
    static $checked = false;
    if ($checked) {
        return;
    }
    $checked = true;

    try {
        $colInfo = db()->query(
            "SELECT COLUMN_TYPE FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME   = 'students'
               AND COLUMN_NAME  = 'student_code'
             LIMIT 1"
        )->fetch();

        if (!$colInfo) {
            return;
        }

        $currentType = strtolower((string) ($colInfo['COLUMN_TYPE'] ?? ''));
        if ($currentType === 'char(6)') {
            return;
        }

        // Only alter if every existing code is already 6-digit numeric
        $bad = db()->query(
            "SELECT COUNT(*) AS c FROM students WHERE student_code NOT REGEXP '^[0-9]{6}$'"
        )->fetch();

        if ((int) ($bad['c'] ?? 1) > 0) {
            return; // run migrate_student_codes.php first
        }

        db()->exec('ALTER TABLE students MODIFY COLUMN student_code CHAR(6) NOT NULL');

        $ckExists = db()->query(
            "SELECT CONSTRAINT_NAME
             FROM information_schema.TABLE_CONSTRAINTS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME   = 'students'
               AND CONSTRAINT_NAME = 'chk_student_code'
             LIMIT 1"
        )->fetch();
        if (!$ckExists) {
            db()->exec(
                "ALTER TABLE students
                 ADD CONSTRAINT chk_student_code
                 CHECK (student_code REGEXP '^[0-9]{6}$')"
            );
        }
    } catch (Throwable $e) {
        // Keep API usable even if schema changes are blocked.
    }
}

function ensure_exam_code_column(): void
{
    static $checked = false;
    if ($checked) {
        return;
    }
    $checked = true;

    try {
        $colExists = db()->query("SHOW COLUMNS FROM subject_activities LIKE 'exam_code'")->fetch();
        if (!$colExists) {
            db()->exec('ALTER TABLE subject_activities ADD COLUMN exam_code CHAR(6) NULL');
        }
        $idxExists = db()->query(
            "SHOW INDEX FROM subject_activities WHERE Key_name = 'uq_exam_code'"
        )->fetch();
        if (!$idxExists) {
            db()->exec('ALTER TABLE subject_activities ADD UNIQUE KEY uq_exam_code (exam_code)');
        }
    } catch (Throwable $e) {
        // Keep API usable even if schema changes are blocked.
    }
}

function ensure_scan_staging_schema(): void
{
    static $checked = false;
    if ($checked) {
        return;
    }
    $checked = true;

    try {
        db()->exec(
            "CREATE TABLE IF NOT EXISTS scan_staging (
                id           INT AUTO_INCREMENT PRIMARY KEY,
                session_id   VARCHAR(36) NOT NULL,
                sheet_index  INT NOT NULL,
                student_code CHAR(6) NULL,
                exam_code    CHAR(6) NULL,
                raw_answers  VARCHAR(120) NULL,
                score        INT NULL,
                max_score    INT NULL,
                status       ENUM('ok','flagged') NOT NULL DEFAULT 'ok',
                flag_reasons TEXT NULL,
                scan_image   MEDIUMTEXT NULL,
                created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_session (session_id)
            )"
        );
    } catch (Throwable $e) {
        // Keep API usable even if schema changes are blocked.
    }
}

function ensure_submissions_exam_title_column(): void
{
    static $checked = false;
    if ($checked) {
        return;
    }
    $checked = true;

    try {
        $existsStmt = db()->query("SHOW COLUMNS FROM submissions LIKE 'exam_title'");
        $exists = $existsStmt->fetch();
        if ($exists) {
            return;
        }

        db()->exec("ALTER TABLE submissions ADD COLUMN exam_title VARCHAR(200) NULL AFTER exam_id");
        db()->exec(
            'UPDATE submissions s
             INNER JOIN exams e ON e.id = s.exam_id
             SET s.exam_title = e.title
             WHERE s.exam_title IS NULL OR s.exam_title = ""'
        );
    } catch (Throwable $e) {
        // Keep API usable even if schema changes are blocked.
    }
}

function ensure_lms_schema(): void
{
    static $checked = false;
    if ($checked) {
        return;
    }
    $checked = true;

    try {
        db()->exec(
            "CREATE TABLE IF NOT EXISTS subjects (
                id INT AUTO_INCREMENT PRIMARY KEY,
                educator_id INT NOT NULL,
                subject_code VARCHAR(40) NOT NULL,
                title VARCHAR(160) NOT NULL,
                term_label VARCHAR(80) NULL,
                description TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_subjects_educator_id (educator_id),
                UNIQUE KEY uq_subject_code_per_educator (educator_id, subject_code),
                CONSTRAINT fk_subjects_educator FOREIGN KEY (educator_id) REFERENCES educators(id)
                    ON DELETE CASCADE
                    ON UPDATE CASCADE
            )"
        );
        $subjectEducatorExists = db()->query("SHOW COLUMNS FROM subjects LIKE 'educator_id'")->fetch();
        if (!$subjectEducatorExists) {
            db()->exec("ALTER TABLE subjects ADD COLUMN educator_id INT NULL AFTER id");
        }
        $defaultEducatorIdRow = db()->query('SELECT MIN(id) AS id FROM educators')->fetch();
        $defaultEducatorId = (int) ($defaultEducatorIdRow['id'] ?? 0);
        if ($defaultEducatorId < 1) {
            $defaultEducatorId = 1;
        }
        $backfillStmt = db()->prepare('UPDATE subjects SET educator_id = :educator_id WHERE educator_id IS NULL');
        $backfillStmt->execute([':educator_id' => $defaultEducatorId]);
        db()->exec('ALTER TABLE subjects MODIFY COLUMN educator_id INT NOT NULL');
        $legacySubjectCodeIndex = db()->query("SHOW INDEX FROM subjects WHERE Key_name = 'uq_subject_code'")->fetch();
        if ($legacySubjectCodeIndex) {
            db()->exec('ALTER TABLE subjects DROP INDEX uq_subject_code');
        }
        $scopedSubjectCodeIndex = db()->query("SHOW INDEX FROM subjects WHERE Key_name = 'uq_subject_code_per_educator'")->fetch();
        if (!$scopedSubjectCodeIndex) {
            db()->exec('ALTER TABLE subjects ADD UNIQUE KEY uq_subject_code_per_educator (educator_id, subject_code)');
        }
        $subjectsEducatorFk = db()->query(
            "SELECT CONSTRAINT_NAME
             FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'subjects'
               AND COLUMN_NAME = 'educator_id'
               AND REFERENCED_TABLE_NAME = 'educators'
             LIMIT 1"
        )->fetch();
        if (!$subjectsEducatorFk) {
            db()->exec(
                'ALTER TABLE subjects
                 ADD CONSTRAINT fk_subjects_educator
                 FOREIGN KEY (educator_id) REFERENCES educators(id)
                 ON DELETE CASCADE
                 ON UPDATE CASCADE'
            );
        }
        db()->exec(
            "CREATE TABLE IF NOT EXISTS students (
                id INT AUTO_INCREMENT PRIMARY KEY,
                student_code VARCHAR(64) NOT NULL,
                surname VARCHAR(180) NOT NULL,
                given_name VARCHAR(120) NULL,
                middle_name VARCHAR(120) NULL,
                email VARCHAR(180) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_student_code (student_code)
            )"
        );
        $studentSurnameExists = db()->query("SHOW COLUMNS FROM students LIKE 'surname'")->fetch();
        if (!$studentSurnameExists) {
            $studentFullNameExists = db()->query("SHOW COLUMNS FROM students LIKE 'full_name'")->fetch();
            if ($studentFullNameExists) {
                db()->exec("ALTER TABLE students CHANGE COLUMN full_name surname VARCHAR(180) NOT NULL");
            } else {
                db()->exec("ALTER TABLE students ADD COLUMN surname VARCHAR(180) NOT NULL AFTER student_code");
            }
        }
        $studentGivenNameExists = db()->query("SHOW COLUMNS FROM students LIKE 'given_name'")->fetch();
        if (!$studentGivenNameExists) {
            db()->exec("ALTER TABLE students ADD COLUMN given_name VARCHAR(120) NULL AFTER surname");
        }
        $studentMiddleNameExists = db()->query("SHOW COLUMNS FROM students LIKE 'middle_name'")->fetch();
        if (!$studentMiddleNameExists) {
            db()->exec("ALTER TABLE students ADD COLUMN middle_name VARCHAR(120) NULL AFTER given_name");
        }
        db()->exec(
            "CREATE TABLE IF NOT EXISTS subject_students (
                subject_id INT NOT NULL,
                student_id INT NOT NULL,
                enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (subject_id, student_id),
                INDEX idx_subject_students_student_id (student_id),
                CONSTRAINT fk_subject_students_subject FOREIGN KEY (subject_id) REFERENCES subjects(id)
                    ON DELETE CASCADE
                    ON UPDATE CASCADE,
                CONSTRAINT fk_subject_students_student FOREIGN KEY (student_id) REFERENCES students(id)
                    ON DELETE CASCADE
                    ON UPDATE CASCADE
            )"
        );
        db()->exec(
            "CREATE TABLE IF NOT EXISTS subject_activities (
                id INT AUTO_INCREMENT PRIMARY KEY,
                subject_id INT NOT NULL,
                title VARCHAR(180) NOT NULL,
                activity_type VARCHAR(24) NOT NULL DEFAULT 'exam',
                exam_id INT NULL,
                exam_code CHAR(6) NULL,
                max_score INT NOT NULL DEFAULT 100,
                due_at DATETIME NULL,
                grading_period ENUM('Q1','Q2','Q3','Q4') NULL,
                publish_status VARCHAR(16) NOT NULL DEFAULT 'draft',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_subject_activities_subject_id (subject_id),
                INDEX idx_subject_activities_exam_id (exam_id),
                UNIQUE KEY uq_exam_code (exam_code),
                CONSTRAINT fk_subject_activities_subject FOREIGN KEY (subject_id) REFERENCES subjects(id)
                    ON DELETE CASCADE
                    ON UPDATE CASCADE,
                CONSTRAINT fk_subject_activities_exam FOREIGN KEY (exam_id) REFERENCES exams(id)
                    ON DELETE SET NULL
                    ON UPDATE CASCADE
            )"
        );
        if (!db()->query("SHOW COLUMNS FROM subject_activities LIKE 'grading_period'")->fetch()) {
            db()->exec("ALTER TABLE subject_activities ADD COLUMN grading_period ENUM('Q1','Q2','Q3','Q4') NULL");
        }
        db()->exec(
            "CREATE TABLE IF NOT EXISTS subject_announcements (
                id INT AUTO_INCREMENT PRIMARY KEY,
                subject_id INT NOT NULL,
                title VARCHAR(180) NOT NULL,
                body TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_subject_announcements_subject_id (subject_id),
                CONSTRAINT fk_subject_announcements_subject FOREIGN KEY (subject_id) REFERENCES subjects(id)
                    ON DELETE CASCADE
                    ON UPDATE CASCADE
            )"
        );
    } catch (Throwable $e) {
        // Keep API usable even if schema changes are blocked.
    }
}

function ensure_educators_schema(): void
{
    static $checked = false;
    if ($checked) {
        return;
    }
    $checked = true;

    try {
        db()->exec(
            "CREATE TABLE IF NOT EXISTS educators (
                id INT AUTO_INCREMENT PRIMARY KEY,
                surname VARCHAR(180) NOT NULL,
                email VARCHAR(180) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                profile_photo_data MEDIUMTEXT NULL,
                is_active TINYINT(1) NOT NULL DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_educator_email (email)
            )"
        );
        $educatorSurnameExists = db()->query("SHOW COLUMNS FROM educators LIKE 'surname'")->fetch();
        if (!$educatorSurnameExists) {
            $educatorFullNameExists = db()->query("SHOW COLUMNS FROM educators LIKE 'full_name'")->fetch();
            if ($educatorFullNameExists) {
                db()->exec("ALTER TABLE educators CHANGE COLUMN full_name surname VARCHAR(180) NOT NULL");
            } else {
                db()->exec("ALTER TABLE educators ADD COLUMN surname VARCHAR(180) NOT NULL AFTER id");
            }
        }
        $photoExistsStmt = db()->query("SHOW COLUMNS FROM educators LIKE 'profile_photo_data'");
        $photoExists = $photoExistsStmt->fetch();
        if (!$photoExists) {
            db()->exec('ALTER TABLE educators ADD COLUMN profile_photo_data MEDIUMTEXT NULL AFTER password_hash');
        }

        $countStmt = db()->query('SELECT COUNT(*) AS c FROM educators');
        $countRow = $countStmt->fetch();
        $count = (int) ($countRow['c'] ?? 0);
        if ($count < 1 && getenv('EXAM_DISABLE_DEFAULT_EDUCATOR') !== '1') {
            $insert = db()->prepare(
                'INSERT INTO educators (surname, email, password_hash, is_active)
                 VALUES (:surname, :email, :password_hash, 1)'
            );
            $insert->execute([
                ':surname' => 'Default Educator',
                ':email' => 'educator@example.com',
                ':password_hash' => password_hash('password123', PASSWORD_DEFAULT),
            ]);
        }
    } catch (Throwable $e) {
        // Keep API usable even if schema changes are blocked.
    }
}

function map_educator_public(array $row): array
{
    $photoData = null;
    if (array_key_exists('profile_photo_data', $row) && $row['profile_photo_data'] !== null) {
        $photoData = (string) $row['profile_photo_data'];
    }

    return [
        'id' => (int) ($row['id'] ?? 0),
        'surname' => (string) ($row['surname'] ?? ''),
        'email' => (string) ($row['email'] ?? ''),
        'profile_photo_data' => $photoData,
    ];
}

function require_lms_educator_id(): int
{
    $educatorId = scoped_educator_id((int) ($_GET['educator_id'] ?? 0));
    if ($educatorId < 1) {
        json_response(400, ['ok' => false, 'error' => 'educator_id is required']);
    }

    $stmt = db()->prepare(
        'SELECT id
         FROM educators
         WHERE id = :id AND is_active = 1
         LIMIT 1'
    );
    $stmt->execute([':id' => $educatorId]);
    if (!$stmt->fetch()) {
        json_response(404, ['ok' => false, 'error' => 'Educator not found']);
    }

    return $educatorId;
}

function exam_by_id(int $examId): ?array
{
    $owner = session_educator_id();
    $sql = 'SELECT id, title, total_items, answer_key FROM exams WHERE id = :id';
    $parameters = [':id' => $examId];
    if ($owner !== null) {
        $sql .= ' AND educator_id = :owner';
        $parameters[':owner'] = $owner;
    }
    $stmt = db()->prepare($sql);
    $stmt->execute($parameters);
    return $stmt->fetch() ?: null;
}

function require_scan_session(string $sessionId): void
{
    $owner = session_educator_id();
    if ($owner !== null && !scan_session_owned_by($sessionId, $owner)) {
        json_response(404, ['ok' => false, 'error' => 'Scan session not found']);
    }
}

function scan_session_owned_by(string $sessionId, int $owner): bool
{
    if ($sessionId === '') {
        return false;
    }
    $stmt = db()->prepare('SELECT 1 FROM scan_sessions WHERE id = :id AND educator_id = :owner');
    $stmt->execute([':id' => $sessionId, ':owner' => $owner]);
    return (bool) $stmt->fetchColumn();
}

function find_subject_or_404(int $subjectId, int $educatorId): array
{
    $stmt = db()->prepare(
        'SELECT id, educator_id, subject_code, title, term_label, description, created_at
         FROM subjects
         WHERE id = :id AND educator_id = :educator_id
         LIMIT 1'
    );
    $stmt->execute([
        ':id' => $subjectId,
        ':educator_id' => $educatorId,
    ]);
    $subject = $stmt->fetch();
    if (!$subject) {
        json_response(404, ['ok' => false, 'error' => 'Subject not found']);
    }
    return $subject;
}

if (!db_is_postgres()) {
    ensure_submissions_exam_title_column();
    ensure_educators_schema();
    ensure_lms_schema();
    ensure_student_code_schema();
    ensure_exam_code_column();
    ensure_scan_staging_schema();
}

if ($path === '/auth/session' && $method === 'GET') {
    $educatorId = educator_sessions_required() ? educator_session_user_id() : null;
    $educator = null;
    if ($educatorId !== null) {
        $stmt = db()->prepare('SELECT id, surname, email, profile_photo_data FROM educators WHERE id = :id');
        $stmt->execute([':id' => $educatorId]);
        $educator = $stmt->fetch();
    }
    json_response(200, ['ok' => true, 'data' => ['educator' => $educator ? map_educator_public($educator) : null]]);
}

if ($path === '/auth/logout' && $method === 'POST') {
    if (educator_sessions_required()) {
        revoke_current_educator_session();
        write_educator_session_cookie('', time() - 3600);
    }
    json_response(200, ['ok' => true]);
}

if ($path === '/auth/account' && $method === 'GET') {
    $educatorId = scoped_educator_id((int) ($_GET['educator_id'] ?? 0));
    if ($educatorId < 1) {
        json_response(400, ['ok' => false, 'error' => 'educator_id is required']);
    }

    $stmt = db()->prepare(
        'SELECT id, surname, email, profile_photo_data, is_active
         FROM educators
         WHERE id = :id
         LIMIT 1'
    );
    $stmt->execute([':id' => $educatorId]);
    $educator = $stmt->fetch();
    if (!$educator || !(bool) ($educator['is_active'] ?? false)) {
        json_response(404, ['ok' => false, 'error' => 'Educator not found']);
    }

    json_response(200, [
        'ok' => true,
        'data' => [
            'educator' => map_educator_public($educator),
        ],
    ]);
}

if ($path === '/auth/account' && $method === 'POST') {
    $payload = request_json();
    $educatorId = scoped_educator_id((int) ($payload['educator_id'] ?? 0));
    $fullName = trim((string) ($payload['surname'] ?? ''));
    $email = strtolower(trim((string) ($payload['email'] ?? '')));
    $currentPassword = (string) ($payload['current_password'] ?? '');
    $password = (string) ($payload['password'] ?? '');
    $profilePhotoData = $payload['profile_photo_data'] ?? null;
    $profilePhotoData = $profilePhotoData !== null ? trim((string) $profilePhotoData) : null;
    if ($profilePhotoData === '') {
        $profilePhotoData = null;
    }

    if ($educatorId < 1 || $fullName === '' || $email === '') {
        json_response(400, ['ok' => false, 'error' => 'educator_id, surname, and email are required']);
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        json_response(400, ['ok' => false, 'error' => 'Invalid email address']);
    }
    if ($password !== '' && strlen($password) < 8) {
        json_response(400, ['ok' => false, 'error' => 'Password must be at least 8 characters']);
    }
    if ($password !== '' && trim($currentPassword) === '') {
        json_response(400, ['ok' => false, 'error' => 'current_password is required to change password']);
    }
    if ($profilePhotoData !== null && strlen($profilePhotoData) > 2000000) {
        json_response(400, ['ok' => false, 'error' => 'Profile photo is too large']);
    }

    $findStmt = db()->prepare(
        'SELECT id, email, password_hash, is_active
         FROM educators
         WHERE id = :id
         LIMIT 1'
    );
    $findStmt->execute([':id' => $educatorId]);
    $existing = $findStmt->fetch();
    if (!$existing || !(bool) ($existing['is_active'] ?? false)) {
        json_response(404, ['ok' => false, 'error' => 'Educator not found']);
    }
    if ($password !== '') {
        $hash = (string) ($existing['password_hash'] ?? '');
        if ($hash === '' || !password_verify($currentPassword, $hash)) {
            json_response(401, ['ok' => false, 'error' => 'Current password is incorrect']);
        }
    }

    $dupeStmt = db()->prepare(
        'SELECT id
         FROM educators
         WHERE email = :email AND id <> :id
         LIMIT 1'
    );
    $dupeStmt->execute([
        ':email' => $email,
        ':id' => $educatorId,
    ]);
    if ($dupeStmt->fetch()) {
        json_response(409, ['ok' => false, 'error' => 'An educator with this email already exists']);
    }

    if ($password !== '') {
        $updateStmt = db()->prepare(
            'UPDATE educators
             SET surname = :surname,
                 email = :email,
                 profile_photo_data = :profile_photo_data,
                 password_hash = :password_hash
             WHERE id = :id'
        );
        $updateStmt->execute([
            ':surname' => $fullName,
            ':email' => $email,
            ':profile_photo_data' => $profilePhotoData,
            ':password_hash' => password_hash($password, PASSWORD_DEFAULT),
            ':id' => $educatorId,
        ]);
        if (educator_sessions_required()) {
            $delete = db()->prepare('DELETE FROM educator_sessions WHERE educator_id = :id AND token_hash <> :current_token');
            $delete->execute([':id' => $educatorId, ':current_token' => educator_session_token_hash()]);
        }
    } else {
        $updateStmt = db()->prepare(
            'UPDATE educators
             SET surname = :surname,
                 email = :email,
                 profile_photo_data = :profile_photo_data
             WHERE id = :id'
        );
        $updateStmt->execute([
            ':surname' => $fullName,
            ':email' => $email,
            ':profile_photo_data' => $profilePhotoData,
            ':id' => $educatorId,
        ]);
    }

    $resultStmt = db()->prepare(
        'SELECT id, surname, email, profile_photo_data
         FROM educators
         WHERE id = :id
         LIMIT 1'
    );
    $resultStmt->execute([':id' => $educatorId]);
    $educator = $resultStmt->fetch() ?: [];

    json_response(200, [
        'ok' => true,
        'data' => [
            'educator' => map_educator_public($educator),
        ],
    ]);
}

if ($path === '/auth/signup') {
    ensure_method('POST');
    $payload = request_json();
    $fullName = trim((string) ($payload['surname'] ?? ''));
    $email = strtolower(trim((string) ($payload['email'] ?? '')));
    $password = (string) ($payload['password'] ?? '');

    if ($fullName === '' || $email === '' || $password === '') {
        json_response(400, ['ok' => false, 'error' => 'surname, email, and password are required']);
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        json_response(400, ['ok' => false, 'error' => 'Invalid email address']);
    }
    if (strlen($password) < 8) {
        json_response(400, ['ok' => false, 'error' => 'Password must be at least 8 characters']);
    }

    limit_educator_auth_attempts('signup', 20, 3600);

    $existsStmt = db()->prepare('SELECT id FROM educators WHERE email = :email LIMIT 1');
    $existsStmt->execute([':email' => $email]);
    if ($existsStmt->fetch()) {
        json_response(409, ['ok' => false, 'error' => 'An educator with this email already exists']);
    }

    $educatorId = db_insert_id(
        'INSERT INTO educators (surname, email, password_hash, is_active)
         VALUES (:surname, :email, :password_hash, 1)',
        [
            ':surname' => $fullName,
            ':email' => $email,
            ':password_hash' => password_hash($password, PASSWORD_DEFAULT),
        ]
    );
    create_educator_session($educatorId);

    json_response(201, [
        'ok' => true,
        'data' => [
            'educator' => [
                'id' => $educatorId,
                'surname' => $fullName,
                'email' => $email,
                'profile_photo_data' => null,
            ],
        ],
    ]);
}

if ($path === '/auth/login') {
    ensure_method('POST');
    $payload = request_json();
    $email = strtolower(trim((string) ($payload['email'] ?? '')));
    $password = (string) ($payload['password'] ?? '');

    if ($email === '' || $password === '') {
        json_response(400, ['ok' => false, 'error' => 'email and password are required']);
    }

    limit_educator_auth_attempts('login:' . $email, 12, 600);

    $stmt = db()->prepare(
        'SELECT id, surname, email, password_hash, profile_photo_data, is_active
         FROM educators
         WHERE email = :email
         LIMIT 1'
    );
    $stmt->execute([':email' => $email]);
    $educator = $stmt->fetch();

    if (!$educator || !(bool) ($educator['is_active'] ?? false)) {
        json_response(401, ['ok' => false, 'error' => 'Invalid credentials']);
    }

    $hash = (string) ($educator['password_hash'] ?? '');
    if (!password_verify($password, $hash)) {
        json_response(401, ['ok' => false, 'error' => 'Invalid credentials']);
    }

    create_educator_session((int) $educator['id']);

    json_response(200, [
        'ok' => true,
        'data' => [
            'educator' => map_educator_public($educator),
        ],
    ]);
}

if ($path === '/health') {
    ensure_method('GET');
    $dbOk = false;
    try {
        db()->query('SELECT 1');
        $dbOk = true;
    } catch (Throwable $e) {
        $dbOk = false;
    }

    json_response(200, [
        'ok' => true,
        'db' => $dbOk,
        'timestamp' => date(DATE_ATOM),
    ]);
}

if ($path === '/scanner/status') {
    ensure_method('GET');
    if (online_scanner_enabled()) {
        $owner = session_educator_id();
        $sessionId = $_GET['session_id'] ?? null;
        if ($sessionId !== null && (!is_string($sessionId) || !scan_session_owned_by($sessionId, $owner))) {
            json_response(404, ['ok' => false, 'error' => 'Scan session not found']);
        }
        json_response(200, [
            'ok' => true, 'transport' => 'online-scanner',
            'scanner' => online_scanner_status($owner, $sessionId),
        ]);
    }
    $scanner = scanner_request('/status');
    $state = $scanner['data']['scanner'] ?? ['connected' => false];
    $owner = session_educator_id();
    if ($owner !== null) {
        unset($state['last_output'], $state['last_scan_at']);
        if (!scan_session_owned_by((string) ($state['active_session_id'] ?? ''), $owner)) {
            unset(
                $state['active_session_id'], $state['batch_running'], $state['stop_requested'],
                $state['waiting_for_paper'], $state['activity'], $state['feed_attempt'], $state['feed_max_attempts']
            );
        }
        if (!scan_session_owned_by((string) ($state['last_batch_session_id'] ?? ''), $owner)) {
            unset($state['last_batch_session_id'], $state['last_batch_reason'], $state['last_batch_message']);
        }
    }
    json_response(200, [
        'ok' => true,
        'transport' => 'php->python-local',
        'scanner' => $state,
    ]);
}

if ($path === '/scanner/pair' && $method === 'POST' && online_scanner_enabled()) {
    [$status, $response] = online_scanner_pair(session_educator_id());
    json_response($status, $response);
}

if ($path === '/scanner/scan') {
    ensure_method('POST');
    if (online_scanner_enabled()) {
        json_response(409, ['ok' => false, 'error' => 'Use Single Scan or Start Batch Scan for an online scanner.']);
    }
    $payload = request_json();
    if (empty($payload['exam_id'])) {
        json_response(400, ['ok' => false, 'error' => 'exam_id is required']);
    }
    if (educator_sessions_required() && exam_by_id((int) $payload['exam_id']) === null) {
        json_response(404, ['ok' => false, 'error' => 'Exam not found']);
    }

    $scanResult = scanner_request('/scan', 'POST', ['exam_id' => (int) $payload['exam_id']]);
    if (!($scanResult['ok'] ?? false)) {
        json_response(502, ['ok' => false, 'error' => $scanResult['error'] ?? 'Scan failed']);
    }

    $jobId = db_insert_id(
        'INSERT INTO scan_jobs (exam_id, status, raw_payload) VALUES (:exam_id, :status, :raw_payload)',
        [
            ':exam_id' => (int) $payload['exam_id'],
            ':status' => 'completed',
            ':raw_payload' => json_encode($scanResult['data'] ?? []),
        ]
    );

    json_response(200, [
        'ok' => true,
        'data' => [
            'job_id' => $jobId,
            'scan' => $scanResult['data'] ?? [],
        ],
    ]);
}

if ($path === '/exams' && ($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    $owner = session_educator_id();
    $sql = 'SELECT id, title, total_items, answer_key, created_at FROM exams';
    $stmt = db()->prepare($sql . ($owner === null ? '' : ' WHERE educator_id = :owner') . ' ORDER BY id DESC LIMIT 30');
    $stmt->execute($owner === null ? [] : [':owner' => $owner]);
    json_response(200, ['ok' => true, 'data' => $stmt->fetchAll()]);
}

if ($path === '/exams' && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $payload = request_json();
    $title = trim((string) ($payload['title'] ?? ''));
    $totalItems = (int) ($payload['total_items'] ?? 0);
    $answerKey = strtoupper(trim((string) ($payload['answer_key'] ?? '')));

    if ($title === '' || $totalItems < 1 || $answerKey === '') {
        json_response(400, ['ok' => false, 'error' => 'title, total_items, and answer_key are required']);
    }

    $keyItems = parse_answers_input($answerKey);
    if (count($keyItems) !== $totalItems) {
        json_response(400, ['ok' => false, 'error' => 'answer_key must contain exactly total_items answers']);
    }
    foreach ($keyItems as $token) {
        if (!is_valid_answer_token($token)) {
            json_response(400, ['ok' => false, 'error' => 'Invalid answer_key format. Use a single letter (A–D) per item.']);
        }
    }

    $storedAnswerKey = normalize_answers_for_store($keyItems);

    $owner = session_educator_id();
    $parameters = [':title' => $title, ':total_items' => $totalItems, ':answer_key' => $storedAnswerKey];
    if ($owner !== null) {
        $parameters[':owner'] = $owner;
    }
    $sql = $owner === null
        ? 'INSERT INTO exams (title, total_items, answer_key) VALUES (:title, :total_items, :answer_key)'
        : 'INSERT INTO exams (title, total_items, answer_key, educator_id) VALUES (:title, :total_items, :answer_key, :owner)';
    $examId = db_insert_id($sql, $parameters);

    json_response(201, ['ok' => true, 'data' => ['id' => $examId]]);
}

if ($path === '/grade/submit') {
    ensure_method('POST');
    $payload = request_json();

    $examId = (int) ($payload['exam_id'] ?? 0);
    $studentCode = trim((string) ($payload['student_code'] ?? ''));
    $answers = strtoupper(trim((string) ($payload['answers'] ?? '')));

    if ($examId < 1 || $studentCode === '' || $answers === '') {
        json_response(400, ['ok' => false, 'error' => 'exam_id, student_code, answers are required']);
    }

    $exam = exam_by_id($examId);
    if (!$exam) {
        json_response(404, ['ok' => false, 'error' => 'Exam not found']);
    }

    $keyRaw = strtoupper((string) $exam['answer_key']);
    $total = (int) $exam['total_items'];
    $keyItems = parse_answers_input($keyRaw);
    $answerItems = parse_answers_input($answers);

    if (count($answerItems) < $total) {
        json_response(400, ['ok' => false, 'error' => 'answers are shorter than total_items']);
    }
    if (count($answerItems) !== $total) {
        json_response(400, ['ok' => false, 'error' => 'answers must contain exactly total_items entries']);
    }
    if (count($keyItems) !== $total) {
        json_response(422, ['ok' => false, 'error' => 'Stored exam answer key is invalid for total_items']);
    }

    foreach ($answerItems as $token) {
        if (!is_valid_answer_token($token)) {
            json_response(400, ['ok' => false, 'error' => 'Invalid answers format. Use a single letter (A–D) per item.']);
        }
    }

    $score = 0;

    for ($i = 0; $i < $total; $i++) {
        if (($answerItems[$i] ?? '') === ($keyItems[$i] ?? '')) {
            $score++;
        }
    }

    $storedAnswers = normalize_answers_for_store($answerItems);

    $examTitle = trim((string) ($exam['title'] ?? ''));
    $submissionId = db_insert_id(
        'INSERT INTO submissions (exam_id, exam_title, student_code, answers, score)
         VALUES (:exam_id, :exam_title, :student_code, :answers, :score)',
        [
            ':exam_id' => $examId,
            ':exam_title' => $examTitle,
            ':student_code' => $studentCode,
            ':answers' => $storedAnswers,
            ':score' => $score,
        ]
    );

    json_response(200, [
        'ok' => true,
        'data' => [
            'submission_id' => $submissionId,
            'exam_id' => $examId,
            'exam_title' => $examTitle,
            'student_code' => $studentCode,
            'score' => $score,
            'total_items' => $total,
        ],
    ]);
}

if ($path === '/lms/subjects' && $method === 'GET') {
    $educatorId = require_lms_educator_id();
    $stmt = db()->prepare(
        'SELECT s.id, s.subject_code, s.title, s.term_label, s.description, s.created_at,
                COUNT(DISTINCT ss.student_id) AS student_count,
                COUNT(DISTINCT a.id) AS activity_count,
                COUNT(DISTINCT CASE WHEN a.publish_status = :published THEN a.id END) AS published_activity_count
         FROM subjects s
         LEFT JOIN subject_students ss ON ss.subject_id = s.id
         LEFT JOIN subject_activities a ON a.subject_id = s.id
         WHERE s.educator_id = :educator_id
         GROUP BY s.id, s.subject_code, s.title, s.term_label, s.description, s.created_at
         ORDER BY s.created_at DESC'
    );
    $stmt->execute([':educator_id' => $educatorId, ':published' => 'published']);
    $rows = $stmt->fetchAll();
    json_response(200, ['ok' => true, 'data' => $rows]);
}

if ($path === '/lms/subjects' && $method === 'POST') {
    $educatorId = require_lms_educator_id();
    $payload = request_json();
    $payloadEducatorId = (int) ($payload['educator_id'] ?? 0);
    if ($payloadEducatorId > 0 && $payloadEducatorId !== $educatorId) {
        json_response(400, ['ok' => false, 'error' => 'educator_id mismatch']);
    }
    $code = strtoupper(trim((string) ($payload['subject_code'] ?? '')));
    $title = trim((string) ($payload['title'] ?? ''));
    $term = trim((string) ($payload['term_label'] ?? ''));
    $description = trim((string) ($payload['description'] ?? ''));

    if ($code === '' || $title === '') {
        json_response(400, ['ok' => false, 'error' => 'subject_code and title are required']);
    }

    try {
        $subjectId = db_insert_id(
            'INSERT INTO subjects (educator_id, subject_code, title, term_label, description)
             VALUES (:educator_id, :subject_code, :title, :term_label, :description)',
            [
                ':educator_id' => $educatorId,
                ':subject_code' => $code,
                ':title' => $title,
                ':term_label' => $term !== '' ? $term : null,
                ':description' => $description !== '' ? $description : null,
            ]
        );
    } catch (Throwable $e) {
        json_response(409, ['ok' => false, 'error' => 'Subject code already exists for this educator']);
    }

    json_response(201, ['ok' => true, 'data' => ['id' => $subjectId]]);
}

if (preg_match('#^/lms/subjects/(\d+)$#', $path, $matches)) {
    $educatorId = require_lms_educator_id();
    $subjectId = (int) $matches[1];
    if ($method === 'PUT') {
        find_subject_or_404($subjectId, $educatorId);
        $payload = request_json();
        $code = strtoupper(trim((string) ($payload['subject_code'] ?? '')));
        $title = trim((string) ($payload['title'] ?? ''));
        $term = trim((string) ($payload['term_label'] ?? ''));
        if ($code === '' || $title === '') {
            json_response(400, ['ok' => false, 'error' => 'subject_code and title are required']);
        }

        $stmt = db()->prepare(
            'UPDATE subjects
             SET subject_code = :subject_code,
                 title = :title,
                 term_label = :term_label
             WHERE id = :id AND educator_id = :educator_id'
        );
        try {
            $stmt->execute([
                ':subject_code' => $code,
                ':title' => $title,
                ':term_label' => $term !== '' ? $term : null,
                ':id' => $subjectId,
                ':educator_id' => $educatorId,
            ]);
        } catch (Throwable $e) {
            json_response(409, ['ok' => false, 'error' => 'Subject code already exists for this educator']);
        }

        json_response(200, ['ok' => true]);
    }
    if ($method === 'DELETE') {
        $stmt = db()->prepare('DELETE FROM subjects WHERE id = :id AND educator_id = :educator_id');
        $stmt->execute([
            ':id' => $subjectId,
            ':educator_id' => $educatorId,
        ]);
        if ($stmt->rowCount() < 1) {
            json_response(404, ['ok' => false, 'error' => 'Subject not found']);
        }
        json_response(200, ['ok' => true]);
    }
}

if (preg_match('#^/lms/subjects/(\d+)/students$#', $path, $matches)) {
    $educatorId = require_lms_educator_id();
    $subjectId = (int) $matches[1];
    find_subject_or_404($subjectId, $educatorId);

    if ($method === 'GET') {
        $stmt = db()->prepare(
            'SELECT st.id, st.student_code, st.surname, st.given_name, st.middle_name, st.email, ss.enrolled_at
             FROM subject_students ss
             INNER JOIN students st ON st.id = ss.student_id
             WHERE ss.subject_id = :subject_id
             ORDER BY st.surname ASC, st.given_name ASC'
        );
        $stmt->execute([':subject_id' => $subjectId]);
        json_response(200, ['ok' => true, 'data' => $stmt->fetchAll()]);
    }

    if ($method === 'POST') {
        $payload = request_json();
        $studentCode = strtoupper(trim((string) ($payload['student_code'] ?? '')));
        $surname = trim((string) ($payload['surname'] ?? ''));
        $givenName = trim((string) ($payload['given_name'] ?? ''));
        $middleName = trim((string) ($payload['middle_name'] ?? ''));
        $email = trim((string) ($payload['email'] ?? ''));

        if ($studentCode === '' || $surname === '') {
            json_response(400, ['ok' => false, 'error' => 'student_code and surname are required']);
        }

        $owner = session_educator_id();
        $studentScope = $owner === null ? [] : [':owner' => $owner];
        $findStudent = db()->prepare(
            'SELECT id FROM students WHERE student_code = :student_code' . ($owner === null ? '' : ' AND educator_id = :owner')
        );
        $findStudent->execute([':student_code' => $studentCode] + $studentScope);
        $student = $findStudent->fetch();

        if ($student) {
            $studentId = (int) $student['id'];
            $update = db()->prepare(
                'UPDATE students
                 SET surname = :surname,
                     given_name = :given_name,
                     middle_name = :middle_name,
                     email = :email
                 WHERE id = :id'
            );
            $update->execute([
                ':id' => $studentId,
                ':surname' => $surname,
                ':given_name' => $givenName !== '' ? $givenName : null,
                ':middle_name' => $middleName !== '' ? $middleName : null,
                ':email' => $email !== '' ? $email : null,
            ]);
        } else {
            $insertStudent = $owner === null
                ? 'INSERT INTO students (student_code, surname, given_name, middle_name, email)
                   VALUES (:student_code, :surname, :given_name, :middle_name, :email)'
                : 'INSERT INTO students (student_code, surname, given_name, middle_name, email, educator_id)
                   VALUES (:student_code, :surname, :given_name, :middle_name, :email, :owner)';
            $studentId = db_insert_id(
                $insertStudent,
                [
                    ':student_code' => $studentCode,
                    ':surname' => $surname,
                    ':given_name' => $givenName !== '' ? $givenName : null,
                    ':middle_name' => $middleName !== '' ? $middleName : null,
                    ':email' => $email !== '' ? $email : null,
                ] + $studentScope
            );
        }

        $link = db()->prepare(
            db_is_postgres()
                ? 'INSERT INTO subject_students (subject_id, student_id)
                   VALUES (:subject_id, :student_id) ON CONFLICT (subject_id, student_id) DO NOTHING'
                : 'INSERT IGNORE INTO subject_students (subject_id, student_id)
                   VALUES (:subject_id, :student_id)'
        );
        $link->execute([
            ':subject_id' => $subjectId,
            ':student_id' => $studentId,
        ]);

        json_response(201, ['ok' => true, 'data' => ['student_id' => $studentId]]);
    }
}

if (preg_match('#^/lms/subjects/(\d+)/students/(\d+)$#', $path, $matches)) {
    $educatorId = require_lms_educator_id();
    $subjectId = (int) $matches[1];
    $studentId = (int) $matches[2];
    find_subject_or_404($subjectId, $educatorId);

    if ($method === 'PUT') {
        $belongsStmt = db()->prepare(
            'SELECT 1
             FROM subject_students
             WHERE subject_id = :subject_id AND student_id = :student_id
             LIMIT 1'
        );
        $belongsStmt->execute([
            ':subject_id' => $subjectId,
            ':student_id' => $studentId,
        ]);
        if (!$belongsStmt->fetch()) {
            json_response(404, ['ok' => false, 'error' => 'Student not found in subject']);
        }

        $payload = request_json();
        $studentCode = strtoupper(trim((string) ($payload['student_code'] ?? '')));
        $surname = trim((string) ($payload['surname'] ?? ''));
        $givenName = trim((string) ($payload['given_name'] ?? ''));
        $middleName = trim((string) ($payload['middle_name'] ?? ''));
        $email = trim((string) ($payload['email'] ?? ''));

        if ($studentCode === '' || $surname === '') {
            json_response(400, ['ok' => false, 'error' => 'student_code and surname are required']);
        }

        $update = db()->prepare(
            'UPDATE students
             SET student_code = :student_code,
                 surname = :surname,
                 given_name = :given_name,
                 middle_name = :middle_name,
                 email = :email
             WHERE id = :id'
        );
        $update->execute([
            ':id' => $studentId,
            ':student_code' => $studentCode,
            ':surname' => $surname,
            ':given_name' => $givenName !== '' ? $givenName : null,
            ':middle_name' => $middleName !== '' ? $middleName : null,
            ':email' => $email !== '' ? $email : null,
        ]);

        json_response(200, ['ok' => true]);
    }

    if ($method === 'DELETE') {
        $stmt = db()->prepare(
            'DELETE FROM subject_students
             WHERE subject_id = :subject_id AND student_id = :student_id'
        );
        $stmt->execute([
            ':subject_id' => $subjectId,
            ':student_id' => $studentId,
        ]);
        json_response(200, ['ok' => true]);
    }
}

if (preg_match('#^/lms/subjects/(\d+)/activities$#', $path, $matches)) {
    $educatorId = require_lms_educator_id();
    $subjectId = (int) $matches[1];
    find_subject_or_404($subjectId, $educatorId);

    if ($method === 'GET') {
        $stmt = db()->prepare(
            'SELECT a.id, a.subject_id, a.title, a.activity_type, a.exam_id, a.exam_code, a.max_score, a.due_at, a.grading_period, a.publish_status, a.created_at,
                    e.title AS exam_title,
                    COUNT(DISTINCT CASE WHEN sub.id IS NOT NULL THEN sub.id END) AS submission_count
             FROM subject_activities a
             LEFT JOIN exams e ON e.id = a.exam_id
             LEFT JOIN submissions sub ON sub.exam_id = a.exam_id
             WHERE a.subject_id = :subject_id
             GROUP BY a.id, a.subject_id, a.title, a.activity_type, a.exam_id, a.exam_code, a.max_score, a.due_at, a.grading_period, a.publish_status, a.created_at, e.title
             ORDER BY COALESCE(a.due_at, a.created_at) DESC'
        );
        $stmt->execute([':subject_id' => $subjectId]);
        json_response(200, ['ok' => true, 'data' => $stmt->fetchAll()]);
    }

    if ($method === 'POST') {
        $payload = request_json();
        $title = trim((string) ($payload['title'] ?? ''));
        $activityType = strtolower(trim((string) ($payload['activity_type'] ?? 'exam')));
        $publishStatus = strtolower(trim((string) ($payload['publish_status'] ?? 'draft')));
        $examId = (int) ($payload['exam_id'] ?? 0);
        $maxScore = (int) ($payload['max_score'] ?? 100);
        $dueAt = trim((string) ($payload['due_at'] ?? ''));
        $examCode = normalize_exam_code_input($payload['exam_code'] ?? '');
        $gradingPeriod = strtoupper(trim((string) ($payload['grading_period'] ?? '')));

        if ($title === '') {
            json_response(400, ['ok' => false, 'error' => 'title is required']);
        }

        $validTypes = ['exam', 'quiz', 'activity'];
        if (!in_array($activityType, $validTypes, true)) {
            $activityType = 'activity';
        }

        $validStatuses = ['draft', 'published', 'closed'];
        if (!in_array($publishStatus, $validStatuses, true)) {
            $publishStatus = 'draft';
        }

        $validPeriods = ['Q1', 'Q2', 'Q3', 'Q4'];
        if (!in_array($gradingPeriod, $validPeriods, true)) {
            json_response(422, ['ok' => false, 'error' => 'grading_period is required and must be Q1, Q2, Q3, or Q4']);
        }

        if ($maxScore < 1) {
            $maxScore = 100;
        }

        if ($examId > 0) {
            if (exam_by_id($examId) === null) {
                json_response(404, ['ok' => false, 'error' => 'Linked exam not found']);
            }
        } else {
            $examId = null;
        }

        if ($examCode !== null) {
            ensure_exam_code_available($examCode);
        } else {
            $examCode = generate_unique_exam_code();
            if ($examCode === null) {
                json_response(500, ['ok' => false, 'error' => 'Could not generate exam code.']);
            }
        }

        $newActivityId = db_insert_id(
            'INSERT INTO subject_activities (subject_id, title, activity_type, exam_id, exam_code, max_score, due_at, grading_period, publish_status)
             VALUES (:subject_id, :title, :activity_type, :exam_id, :exam_code, :max_score, :due_at, :grading_period, :publish_status)',
            [
                ':subject_id' => $subjectId,
                ':title' => $title,
                ':activity_type' => $activityType,
                ':exam_id' => $examId,
                ':exam_code' => $examCode,
                ':max_score' => $maxScore,
                ':due_at' => $dueAt !== '' ? $dueAt : null,
                ':grading_period' => $gradingPeriod,
                ':publish_status' => $publishStatus,
            ]
        );
        json_response(201, ['ok' => true, 'data' => ['id' => $newActivityId, 'exam_code' => $examCode]]);
    }
}

if (preg_match('#^/lms/subjects/(\d+)/activities/(\d+)$#', $path, $matches)) {
    $educatorId = require_lms_educator_id();
    $subjectId = (int) $matches[1];
    $activityId = (int) $matches[2];
    find_subject_or_404($subjectId, $educatorId);

    if ($method === 'PUT') {
        $exists = db()->prepare(
            'SELECT id
             FROM subject_activities
             WHERE id = :id AND subject_id = :subject_id
             LIMIT 1'
        );
        $exists->execute([
            ':id' => $activityId,
            ':subject_id' => $subjectId,
        ]);
        if (!$exists->fetch()) {
            json_response(404, ['ok' => false, 'error' => 'Activity not found']);
        }

        $payload = request_json();
        $title = trim((string) ($payload['title'] ?? ''));
        $activityType = strtolower(trim((string) ($payload['activity_type'] ?? 'exam')));
        $publishStatus = strtolower(trim((string) ($payload['publish_status'] ?? 'draft')));
        $examId = (int) ($payload['exam_id'] ?? 0);
        $maxScore = (int) ($payload['max_score'] ?? 100);
        $dueAt = trim((string) ($payload['due_at'] ?? ''));
        $examCode = normalize_exam_code_input($payload['exam_code'] ?? '');
        $gradingPeriod = isset($payload['grading_period']) ? strtoupper(trim((string) $payload['grading_period'])) : null;

        if ($title === '') {
            json_response(400, ['ok' => false, 'error' => 'title is required']);
        }

        $validTypes = ['exam', 'quiz', 'activity'];
        if (!in_array($activityType, $validTypes, true)) {
            $activityType = 'activity';
        }

        $validStatuses = ['draft', 'published', 'closed'];
        if (!in_array($publishStatus, $validStatuses, true)) {
            $publishStatus = 'draft';
        }

        $validPeriods = ['Q1', 'Q2', 'Q3', 'Q4'];
        if ($gradingPeriod !== null && !in_array($gradingPeriod, $validPeriods, true)) {
            json_response(422, ['ok' => false, 'error' => 'grading_period must be Q1, Q2, Q3, or Q4']);
        }

        if ($maxScore < 1) {
            $maxScore = 100;
        }

        if ($examId > 0) {
            if (exam_by_id($examId) === null) {
                json_response(404, ['ok' => false, 'error' => 'Linked exam not found']);
            }
        } else {
            $examId = null;
        }

        if ($examCode === null) {
            json_response(400, ['ok' => false, 'error' => 'Exam code is required.']);
        }
        ensure_exam_code_available($examCode, $activityId);

        $update = db()->prepare(
            'UPDATE subject_activities
             SET title = :title,
                 activity_type = :activity_type,
                 exam_id = :exam_id,
                 exam_code = :exam_code,
                 max_score = :max_score,
                 due_at = :due_at,
                 grading_period = :grading_period,
                 publish_status = :publish_status
             WHERE id = :id AND subject_id = :subject_id'
        );
        $update->execute([
            ':id' => $activityId,
            ':subject_id' => $subjectId,
            ':title' => $title,
            ':activity_type' => $activityType,
            ':exam_id' => $examId,
            ':exam_code' => $examCode,
            ':max_score' => $maxScore,
            ':due_at' => $dueAt !== '' ? $dueAt : null,
            ':grading_period' => $gradingPeriod,
            ':publish_status' => $publishStatus,
        ]);

        json_response(200, ['ok' => true]);
    }

    if ($method === 'DELETE') {
        $delete = db()->prepare(
            'DELETE FROM subject_activities
             WHERE id = :id AND subject_id = :subject_id'
        );
        $delete->execute([
            ':id' => $activityId,
            ':subject_id' => $subjectId,
        ]);
        json_response(200, ['ok' => true]);
    }
}

if (preg_match('#^/lms/subjects/(\d+)/announcements$#', $path, $matches)) {
    $educatorId = require_lms_educator_id();
    $subjectId = (int) $matches[1];
    find_subject_or_404($subjectId, $educatorId);

    if ($method === 'GET') {
        $stmt = db()->prepare(
            'SELECT id, subject_id, title, body, created_at
             FROM subject_announcements
             WHERE subject_id = :subject_id
             ORDER BY created_at DESC
             LIMIT 20'
        );
        $stmt->execute([':subject_id' => $subjectId]);
        json_response(200, ['ok' => true, 'data' => $stmt->fetchAll()]);
    }

    if ($method === 'POST') {
        $payload = request_json();
        $title = trim((string) ($payload['title'] ?? ''));
        $body = trim((string) ($payload['body'] ?? ''));

        if ($title === '' || $body === '') {
            json_response(400, ['ok' => false, 'error' => 'title and body are required']);
        }

        $announcementId = db_insert_id(
            'INSERT INTO subject_announcements (subject_id, title, body)
             VALUES (:subject_id, :title, :body)',
            [':subject_id' => $subjectId, ':title' => $title, ':body' => $body]
        );

        json_response(201, ['ok' => true, 'data' => ['id' => $announcementId]]);
    }
}

if (preg_match('#^/lms/subjects/(\d+)/announcements/(\d+)$#', $path, $matches)) {
    $educatorId = require_lms_educator_id();
    $subjectId = (int) $matches[1];
    $announcementId = (int) $matches[2];
    find_subject_or_404($subjectId, $educatorId);

    if ($method === 'PUT') {
        $exists = db()->prepare(
            'SELECT id
             FROM subject_announcements
             WHERE id = :id AND subject_id = :subject_id
             LIMIT 1'
        );
        $exists->execute([
            ':id' => $announcementId,
            ':subject_id' => $subjectId,
        ]);
        if (!$exists->fetch()) {
            json_response(404, ['ok' => false, 'error' => 'Announcement not found']);
        }

        $payload = request_json();
        $title = trim((string) ($payload['title'] ?? ''));
        $body = trim((string) ($payload['body'] ?? ''));

        if ($title === '' || $body === '') {
            json_response(400, ['ok' => false, 'error' => 'title and body are required']);
        }

        $update = db()->prepare(
            'UPDATE subject_announcements
             SET title = :title,
                 body = :body
             WHERE id = :id AND subject_id = :subject_id'
        );
        $update->execute([
            ':id' => $announcementId,
            ':subject_id' => $subjectId,
            ':title' => $title,
            ':body' => $body,
        ]);

        json_response(200, ['ok' => true]);
    }

    if ($method === 'DELETE') {
        $delete = db()->prepare(
            'DELETE FROM subject_announcements
             WHERE id = :id AND subject_id = :subject_id'
        );
        $delete->execute([
            ':id' => $announcementId,
            ':subject_id' => $subjectId,
        ]);
        json_response(200, ['ok' => true]);
    }
}

/* ── Grade Weights ──────────────────────────────────────────────── */
if (preg_match('#^/lms/subjects/(\d+)/grade-weights$#', $path, $matches)) {
    $educatorId = require_lms_educator_id();
    $subjectId = (int) $matches[1];
    find_subject_or_404($subjectId, $educatorId);

    if ($method === 'GET') {
        $stmt = db()->prepare(
            'SELECT written_work_weight, performance_task_weight, quarterly_assessment_weight
             FROM subject_grade_weights
             WHERE subject_id = :subject_id
             LIMIT 1'
        );
        $stmt->execute([':subject_id' => $subjectId]);
        $row = $stmt->fetch();
        json_response(200, ['ok' => true, 'data' => [
            'written_work'          => $row ? (float) $row['written_work_weight'] : 0,
            'performance_task'      => $row ? (float) $row['performance_task_weight'] : 0,
            'quarterly_assessment'  => $row ? (float) $row['quarterly_assessment_weight'] : 0,
        ]]);
    }

    if ($method === 'PUT') {
        $payload = request_json();
        $ww  = max(0, min(100, (float) ($payload['written_work'] ?? 0)));
        $pt  = max(0, min(100, (float) ($payload['performance_task'] ?? 0)));
        $qa  = max(0, min(100, (float) ($payload['quarterly_assessment'] ?? 0)));

        $onConflict = db_is_postgres() ? 'ON CONFLICT (subject_id) DO UPDATE SET' : 'ON DUPLICATE KEY UPDATE';
        $stmt = db()->prepare(
            'INSERT INTO subject_grade_weights (subject_id, written_work_weight, performance_task_weight, quarterly_assessment_weight)
             VALUES (:subject_id, :ww, :pt, :qa) ' . $onConflict . '
               written_work_weight = :ww2,
               performance_task_weight = :pt2,
               quarterly_assessment_weight = :qa2'
        );
        $stmt->execute([
            ':subject_id' => $subjectId,
            ':ww' => $ww, ':pt' => $pt, ':qa' => $qa,
            ':ww2' => $ww, ':pt2' => $pt, ':qa2' => $qa,
        ]);
        json_response(200, ['ok' => true]);
    }
}

/* ── Manual Activity Scores (WW / PT) ──────────────────────────── */
if (preg_match('#^/lms/subjects/(\d+)/activities/(\d+)/scores$#', $path, $matches) && $method === 'PUT') {
    $educatorId = require_lms_educator_id();
    $subjectId  = (int) $matches[1];
    $activityId = (int) $matches[2];
    find_subject_or_404($subjectId, $educatorId);

    $actStmt = db()->prepare(
        'SELECT id, activity_type FROM subject_activities WHERE id = :id AND subject_id = :sid LIMIT 1'
    );
    $actStmt->execute([':id' => $activityId, ':sid' => $subjectId]);
    $act = $actStmt->fetch();
    if (!$act) {
        json_response(404, ['ok' => false, 'error' => 'Activity not found']);
    }
    if ($act['activity_type'] === 'exam') {
        json_response(422, ['ok' => false, 'error' => 'Scores for exam activities are recorded via the scanner, not manually']);
    }

    $payload = request_json();
    $scores = $payload['scores'] ?? [];
    if (!is_array($scores)) {
        json_response(400, ['ok' => false, 'error' => 'scores must be an array']);
    }

    $onConflict = db_is_postgres() ? 'ON CONFLICT (activity_id, student_id) DO UPDATE SET' : 'ON DUPLICATE KEY UPDATE';
    $upsert = db()->prepare(
        'INSERT INTO subject_activity_scores (activity_id, student_id, score)
         VALUES (:activity_id, :student_id, :score) ' . $onConflict . '
         score = :score2, recorded_at = CURRENT_TIMESTAMP'
    );
    $updated = 0;
    $membership = educator_sessions_required()
        ? db()->prepare('SELECT 1 FROM subject_students WHERE subject_id = :subject AND student_id = :student')
        : null;
    foreach ($scores as $entry) {
        $studentId = (int) ($entry['student_id'] ?? 0);
        $score = isset($entry['score']) && $entry['score'] !== null && $entry['score'] !== ''
            ? (float) $entry['score']
            : null;
        if ($studentId < 1) continue;
        if ($membership !== null) {
            $membership->execute([':subject' => $subjectId, ':student' => $studentId]);
            if (!$membership->fetchColumn()) {
                continue;
            }
        }
        $upsert->execute([
            ':activity_id' => $activityId,
            ':student_id'  => $studentId,
            ':score'       => $score,
            ':score2'      => $score,
        ]);
        $updated++;
    }
    json_response(200, ['ok' => true, 'data' => ['updated' => $updated]]);
}

if (preg_match('#^/lms/subjects/(\d+)/gradebook$#', $path, $matches) && $method === 'GET') {
    $educatorId = require_lms_educator_id();
    $subjectId  = (int) $matches[1];
    find_subject_or_404($subjectId, $educatorId);

    $quarter = strtoupper(trim((string) ($_GET['quarter'] ?? '')));
    $validQuarters = ['Q1', 'Q2', 'Q3', 'Q4'];
    $quarterFilter = in_array($quarter, $validQuarters, true) ? $quarter : null;

    // ── Students enrolled in this subject ────────────────────────────
    $studentsStmt = db()->prepare(
        'SELECT st.id AS student_id, st.student_code, st.surname, st.given_name, st.middle_name
         FROM subject_students ss
         INNER JOIN students st ON st.id = ss.student_id
         WHERE ss.subject_id = :subject_id
         ORDER BY st.surname ASC, st.given_name ASC, st.middle_name ASC'
    );
    $studentsStmt->execute([':subject_id' => $subjectId]);
    $students = $studentsStmt->fetchAll();

    // ── Published activities (optionally filtered by quarter) ─────────
    $actSql = 'SELECT a.id AS activity_id, a.title, a.activity_type, a.exam_id,
                      a.max_score, a.due_at, a.grading_period, a.created_at, ex.total_items
               FROM subject_activities a
               LEFT JOIN exams ex ON ex.id = a.exam_id
               WHERE a.subject_id = :subject_id
                 AND a.publish_status = :published';
    if ($quarterFilter !== null) {
        $actSql .= ' AND a.grading_period = :quarter';
    }
    $actSql .= ' ORDER BY COALESCE(a.due_at, a.created_at) ASC, a.id ASC';
    $publishedStmt = db()->prepare($actSql);
    $bindAct = [':subject_id' => $subjectId, ':published' => 'published'];
    if ($quarterFilter !== null) $bindAct[':quarter'] = $quarterFilter;
    $publishedStmt->execute($bindAct);

    $publishedActivities = array_map(static function (array $row): array {
        return [
            'activity_id'   => (int) ($row['activity_id'] ?? 0),
            'title'         => (string) ($row['title'] ?? ''),
            'activity_type' => (string) ($row['activity_type'] ?? 'activity'),
            'exam_id'       => isset($row['exam_id']) ? (int) $row['exam_id'] : null,
            'max_score'     => (float) ($row['max_score'] ?? 0),
            'due_at'        => $row['due_at'] ?? null,
            'grading_period'=> $row['grading_period'] ?? null,
            'total_items'   => isset($row['total_items']) ? (int) $row['total_items'] : null,
        ];
    }, $publishedStmt->fetchAll());

    // ── Separate activity lists by component type ─────────────────────
    $wwActivities  = array_filter($publishedActivities, fn($a) => $a['activity_type'] === 'quiz');
    $ptActivities  = array_filter($publishedActivities, fn($a) => $a['activity_type'] === 'activity');
    $qaActivities  = array_filter($publishedActivities, fn($a) => $a['activity_type'] === 'exam');

    // ── Latest QA (exam) scores per student/exam ──────────────────────
    $scoredExamIds = [];
    foreach ($qaActivities as $act) {
        if ($act['exam_id'] !== null) $scoredExamIds[$act['exam_id']] = true;
    }
    $scoredExamIds = array_values(array_map('intval', array_keys($scoredExamIds)));

    $latestScoresByStudent = [];
    if (count($scoredExamIds) > 0) {
        $ph = implode(',', array_fill(0, count($scoredExamIds), '?'));
        $latestSql = sprintf(
            'SELECT s.student_code, s.exam_id, s.score
             FROM submissions s
             WHERE s.exam_id IN (%s)
               AND s.id IN (
                 SELECT s2.id FROM submissions s2
                 WHERE s2.exam_id IN (%s)
                   AND s2.created_at = (
                     SELECT MAX(s3.created_at) FROM submissions s3
                     WHERE s3.student_code = s2.student_code AND s3.exam_id = s2.exam_id
                   )
               )',
            $ph, $ph
        );
        $latestStmt = db()->prepare($latestSql);
        $latestStmt->execute(array_merge($scoredExamIds, $scoredExamIds));
        foreach ($latestStmt->fetchAll() as $sr) {
            $sc  = strtoupper(trim((string) ($sr['student_code'] ?? '')));
            $eid = (int) ($sr['exam_id'] ?? 0);
            if ($sc === '' || $eid < 1) continue;
            if (!isset($latestScoresByStudent[$sc])) $latestScoresByStudent[$sc] = [];
            $latestScoresByStudent[$sc][$eid] = (float) $sr['score'];
        }
    }

    // ── Manual scores (WW / PT) keyed by [student_id][activity_id] ───
    $wwPtActivityIds = array_values(array_map(
        fn($a) => $a['activity_id'],
        array_merge(array_values($wwActivities), array_values($ptActivities))
    ));
    $manualScoresByStudent = [];
    if (count($wwPtActivityIds) > 0) {
        $mph = implode(',', array_fill(0, count($wwPtActivityIds), '?'));
        $manualStmt = db()->prepare(sprintf(
            'SELECT sas.activity_id, sas.student_id, sas.score
             FROM subject_activity_scores sas
             WHERE sas.activity_id IN (%s)', $mph
        ));
        $manualStmt->execute($wwPtActivityIds);
        foreach ($manualStmt->fetchAll() as $mr) {
            $sid = (int) ($mr['student_id'] ?? 0);
            $aid = (int) ($mr['activity_id'] ?? 0);
            if ($sid < 1 || $aid < 1) continue;
            if (!isset($manualScoresByStudent[$sid])) $manualScoresByStudent[$sid] = [];
            $manualScoresByStudent[$sid][$aid] = $mr['score'] !== null ? (float) $mr['score'] : null;
        }
    }

    // ── Grade weights ─────────────────────────────────────────────────
    $gwStmt = db()->prepare(
        'SELECT written_work_weight, performance_task_weight, quarterly_assessment_weight
         FROM subject_grade_weights WHERE subject_id = :sid LIMIT 1'
    );
    $gwStmt->execute([':sid' => $subjectId]);
    $gwRow = $gwStmt->fetch();
    $gradeWeights = [
        'written_work'         => $gwRow ? (float) $gwRow['written_work_weight'] : 0,
        'performance_task'     => $gwRow ? (float) $gwRow['performance_task_weight'] : 0,
        'quarterly_assessment' => $gwRow ? (float) $gwRow['quarterly_assessment_weight'] : 0,
    ];

    // ── Build per-student rows ────────────────────────────────────────
    $rows = [];
    foreach ($students as $student) {
        $studentId      = (int) ($student['student_id'] ?? 0);
        $studentCodeRaw = (string) ($student['student_code'] ?? '');
        $studentCode    = strtoupper(trim($studentCodeRaw));
        $qaScores       = $latestScoresByStudent[$studentCode] ?? [];
        $manualScores   = $manualScoresByStudent[$studentId]   ?? [];

        $details = [];

        // Written Work details
        $wwEarned = 0.0; $wwPossible = 0.0;
        foreach ($wwActivities as $act) {
            $aid   = $act['activity_id'];
            $score = $manualScores[$aid] ?? null;
            $wwPossible += (float) $act['max_score'];
            if ($score !== null) $wwEarned += $score;
            $details[] = [
                'activity_id'    => $aid,
                'title'          => $act['title'],
                'activity_type'  => $act['activity_type'],
                'grading_period' => $act['grading_period'],
                'max_score'      => $act['max_score'],
                'score'          => $score,
                'status'         => $score !== null ? 'checked' : 'posted',
            ];
        }
        $wwPct = $wwPossible > 0 ? round(($wwEarned / $wwPossible) * 100, 2) : null;

        // Performance Task details
        $ptEarned = 0.0; $ptPossible = 0.0;
        foreach ($ptActivities as $act) {
            $aid   = $act['activity_id'];
            $score = $manualScores[$aid] ?? null;
            $ptPossible += (float) $act['max_score'];
            if ($score !== null) $ptEarned += $score;
            $details[] = [
                'activity_id'    => $aid,
                'title'          => $act['title'],
                'activity_type'  => $act['activity_type'],
                'grading_period' => $act['grading_period'],
                'max_score'      => $act['max_score'],
                'score'          => $score,
                'status'         => $score !== null ? 'checked' : 'posted',
            ];
        }
        $ptPct = $ptPossible > 0 ? round(($ptEarned / $ptPossible) * 100, 2) : null;

        // Quarterly Assessment details
        $qaEarned = 0.0; $qaPossible = 0.0;
        foreach ($qaActivities as $act) {
            $aid        = $act['activity_id'];
            $examId     = $act['exam_id'];
            $totalItems = $act['total_items'] ?? $act['max_score'];
            $score      = ($examId !== null && isset($qaScores[$examId])) ? $qaScores[$examId] : null;
            $qaPossible += (float) ($totalItems > 0 ? $totalItems : $act['max_score']);
            if ($score !== null) $qaEarned += $score;
            $details[] = [
                'activity_id'    => $aid,
                'title'          => $act['title'],
                'activity_type'  => $act['activity_type'],
                'grading_period' => $act['grading_period'],
                'exam_id'        => $examId,
                'max_score'      => $act['max_score'],
                'total_items'    => $act['total_items'],
                'score'          => $score,
                'status'         => $score !== null ? 'checked' : ($examId !== null ? 'pending' : 'posted'),
            ];
        }
        $qaPct = $qaPossible > 0 ? round(($qaEarned / $qaPossible) * 100, 2) : null;

        // Weighted final grade (only components with activities and non-zero weight)
        $finalGrade = null;
        $totalWeight = 0.0;
        $weightedSum = 0.0;
        if ($wwPossible > 0 && $gradeWeights['written_work'] > 0) {
            $weightedSum += ($wwPct ?? 0) * ($gradeWeights['written_work'] / 100);
            $totalWeight += $gradeWeights['written_work'];
        }
        if ($ptPossible > 0 && $gradeWeights['performance_task'] > 0) {
            $weightedSum += ($ptPct ?? 0) * ($gradeWeights['performance_task'] / 100);
            $totalWeight += $gradeWeights['performance_task'];
        }
        if ($qaPossible > 0 && $gradeWeights['quarterly_assessment'] > 0) {
            $weightedSum += ($qaPct ?? 0) * ($gradeWeights['quarterly_assessment'] / 100);
            $totalWeight += $gradeWeights['quarterly_assessment'];
        }
        if ($totalWeight > 0) {
            $finalGrade = round($weightedSum, 2);
        }

        $rows[] = [
            'student_id'       => $studentId,
            'student_code'     => $studentCodeRaw,
            'surname'          => (string) ($student['surname'] ?? ''),
            'given_name'       => (string) ($student['given_name'] ?? ''),
            'middle_name'      => (string) ($student['middle_name'] ?? ''),
            'ww_component_pct' => $wwPct,
            'pt_component_pct' => $ptPct,
            'qa_component_pct' => $qaPct,
            'final_grade'      => $finalGrade,
            'published_details'=> $details,
            // legacy fields kept for backward compat
            'published_activities' => count($publishedActivities),
            'completed_activities' => count(array_filter($details, fn($d) => $d['status'] === 'checked')),
            'average_percent'  => $finalGrade,
        ];
    }

    json_response(200, [
        'ok' => true,
        'data' => [
            'rows'                => $rows,
            'published_activities'=> $publishedActivities,
            'grade_weights'       => $gradeWeights,
        ],
    ]);
}

if (preg_match('#^/lms/subjects/(\d+)/exam-results$#', $path, $matches) && $method === 'GET') {
    $educatorId = require_lms_educator_id();
    $subjectId  = (int) $matches[1];
    find_subject_or_404($subjectId, $educatorId);

    // ── Students enrolled in this subject ────────────────────────────
    $studentsStmt = db()->prepare(
        'SELECT st.id AS student_id, st.student_code, st.surname, st.given_name, st.middle_name
         FROM subject_students ss
         INNER JOIN students st ON st.id = ss.student_id
         WHERE ss.subject_id = :subject_id
         ORDER BY st.surname ASC, st.given_name ASC, st.middle_name ASC'
    );
    $studentsStmt->execute([':subject_id' => $subjectId]);
    $students = $studentsStmt->fetchAll();

    // ── Exam activities linked to an answer key ───────────────────────
    $examStmt = db()->prepare(
        'SELECT a.id AS activity_id, a.title, a.exam_id, a.publish_status, a.due_at, a.created_at,
                ex.total_items, ex.answer_key
         FROM subject_activities a
         INNER JOIN exams ex ON ex.id = a.exam_id
         WHERE a.subject_id = :subject_id
           AND a.activity_type = :exam_type
         ORDER BY COALESCE(a.due_at, a.created_at) DESC, a.id DESC'
    );
    $examStmt->execute([':subject_id' => $subjectId, ':exam_type' => 'exam']);
    $examRows = $examStmt->fetchAll();

    // ── Latest submission per student/exam (later rows overwrite earlier) ─
    $latest = [];
    $examIds = array_values(array_unique(array_map(static fn($r) => (int) $r['exam_id'], $examRows)));
    if (count($examIds) > 0) {
        $ph = implode(',', array_fill(0, count($examIds), '?'));
        $subStmt = db()->prepare(sprintf(
            'SELECT id, exam_id, student_code, answers, score, created_at
             FROM submissions WHERE exam_id IN (%s)
             ORDER BY created_at ASC, id ASC', $ph
        ));
        $subStmt->execute($examIds);
        foreach ($subStmt->fetchAll() as $sr) {
            $sc = strtoupper(trim((string) ($sr['student_code'] ?? '')));
            if ($sc === '') continue;
            $latest[(int) $sr['exam_id']][$sc] = $sr;
        }
    }

    $exams = [];
    foreach ($examRows as $er) {
        $examId     = (int) $er['exam_id'];
        $totalItems = (int) $er['total_items'];
        $key        = parse_answers_input(strtoupper((string) $er['answer_key']));

        $results = [];
        foreach ($students as $student) {
            $sc  = strtoupper(trim((string) ($student['student_code'] ?? '')));
            $sub = $latest[$examId][$sc] ?? null;
            $answers = null;
            if ($sub !== null) {
                // keep blanks so item positions line up with the key
                $answers = array_map(
                    static fn($a) => normalize_answer_token((string) $a),
                    array_slice(explode('|', (string) $sub['answers']), 0, $totalItems)
                );
                $answers = array_pad($answers, $totalItems, '');
            }
            $results[] = [
                'student_id'    => (int) $student['student_id'],
                'student_code'  => (string) $student['student_code'],
                'surname'       => (string) ($student['surname'] ?? ''),
                'given_name'    => (string) ($student['given_name'] ?? ''),
                'middle_name'   => (string) ($student['middle_name'] ?? ''),
                'submission_id' => $sub !== null ? (int) $sub['id'] : null,
                'score'         => $sub !== null ? (int) $sub['score'] : null,
                'answers'       => $answers,
                'submitted_at'  => $sub['created_at'] ?? null,
            ];
        }

        $exams[] = [
            'activity_id'    => (int) $er['activity_id'],
            'title'          => (string) $er['title'],
            'exam_id'        => $examId,
            'publish_status' => (string) $er['publish_status'],
            'due_at'         => $er['due_at'] ?? null,
            'total_items'    => $totalItems,
            'answer_key'     => $key,
            'results'        => $results,
        ];
    }

    json_response(200, ['ok' => true, 'data' => ['exams' => $exams]]);
}

/* ═══════════════════════════════════════════════════════
   EXAM CODE LOOKUP  (used by OMR service)
═══════════════════════════════════════════════════════ */

function exam_code_data(string $code, ?int $owner): ?array
{
    $stmt = db()->prepare(
        'SELECT a.id AS activity_id, a.title AS activity_title, a.exam_id, a.subject_id,
                e.answer_key, e.total_items
         FROM subject_activities a
         INNER JOIN exams e ON e.id = a.exam_id
         WHERE a.exam_code = :code' . ($owner === null ? '' : ' AND e.educator_id = :owner') . ' LIMIT 1'
    );
    $stmt->execute([':code' => $code] + ($owner === null ? [] : [':owner' => $owner]));
    $row = $stmt->fetch();

    return $row ? [
        'activity_id'    => (int) $row['activity_id'],
        'activity_title' => (string) $row['activity_title'],
        'exam_id'        => (int) $row['exam_id'],
        'answer_key'     => parse_answers_input(strtoupper((string) ($row['answer_key'] ?? ''))),
        'total_items'    => (int) $row['total_items'],
        'subject_id'     => (int) $row['subject_id'],
    ] : null;
}

if (preg_match('#^/lms/exam-code/([0-9]{6})$#', $path, $matches) && $method === 'GET') {
    $data = exam_code_data($matches[1], session_educator_id());
    if ($data === null) {
        json_response(404, ['ok' => false, 'error' => 'Exam code not found']);
    }
    json_response(200, ['ok' => true, 'data' => $data]);
}

/* ═══════════════════════════════════════════════════════
   SCANNER BATCH PROXY  (forwards to Python service)
═══════════════════════════════════════════════════════ */

if ($path === '/scanner/batch-scan' && $method === 'POST') {
    $payload = request_json();
    $sessionId = (string) ($payload['session_id'] ?? '');
    require_scan_session($sessionId);
    if (online_scanner_enabled()) {
        [$status, $response] = online_scanner_queue(session_educator_id(), $sessionId, ($payload['single'] ?? null) === true);
        json_response($status, $response);
    }
    $result  = scanner_request('/batch-scan', 'POST', $payload);
    json_response($result['ok'] ?? false ? 200 : 502, $result);
}

if ($path === '/scanner/batch-stop' && $method === 'POST') {
    $payload = request_json();
    $sessionId = (string) ($payload['session_id'] ?? '');
    require_scan_session($sessionId);
    if (online_scanner_enabled()) {
        [$status, $response] = online_scanner_stop(session_educator_id(), $sessionId);
        json_response($status, $response);
    }
    $result = scanner_request('/batch-stop', 'POST', $payload);
    json_response($result['ok'] ?? false ? 200 : 502, $result);
}

/* ═══════════════════════════════════════════════════════
   SCAN SESSION ENDPOINTS
═══════════════════════════════════════════════════════ */

if ($path === '/scan/session/start' && $method === 'POST') {
    $sessionId = sprintf(
        '%s-%s-%s-%s-%s',
        bin2hex(random_bytes(4)),
        bin2hex(random_bytes(2)),
        bin2hex(random_bytes(2)),
        bin2hex(random_bytes(2)),
        bin2hex(random_bytes(6))
    );
    $owner = session_educator_id();
    if ($owner !== null) {
        $stmt = db()->prepare('INSERT INTO scan_sessions (id, educator_id) VALUES (:id, :owner)');
        $stmt->execute([':id' => $sessionId, ':owner' => $owner]);
    }
    json_response(200, ['ok' => true, 'data' => ['session_id' => $sessionId]]);
}

function store_scan_sheet(string $sessionId, array $payload): void
{
    $sheetIndex  = (int) ($payload['sheet_index'] ?? 0);
    $studentCode = isset($payload['student_code']) && $payload['student_code'] !== null
        ? (string) $payload['student_code'] : null;
    $examCode    = isset($payload['exam_code']) && $payload['exam_code'] !== null
        ? (string) $payload['exam_code'] : null;
    $rawAnswers  = isset($payload['raw_answers']) ? (string) $payload['raw_answers'] : null;
    $score       = isset($payload['score']) ? (int) $payload['score'] : null;
    $maxScore    = isset($payload['max_score']) ? (int) $payload['max_score'] : null;
    $status      = in_array($payload['status'] ?? '', ['ok', 'flagged'], true)
        ? (string) $payload['status'] : 'flagged';
    $flagReasons = isset($payload['flag_reasons']) && is_array($payload['flag_reasons'])
        ? json_encode($payload['flag_reasons']) : null;
    $scanImage   = isset($payload['scan_image']) ? (string) $payload['scan_image'] : null;

    $ins = db()->prepare(
        'INSERT INTO scan_staging
            (session_id, sheet_index, student_code, exam_code, raw_answers,
             score, max_score, status, flag_reasons, scan_image)
         VALUES
            (:session_id, :sheet_index, :student_code, :exam_code, :raw_answers,
             :score, :max_score, :status, :flag_reasons, :scan_image)'
    );
    $ins->execute([
        ':session_id'   => $sessionId,
        ':sheet_index'  => $sheetIndex,
        ':student_code' => $studentCode,
        ':exam_code'    => $examCode,
        ':raw_answers'  => $rawAnswers,
        ':score'        => $score,
        ':max_score'    => $maxScore,
        ':status'       => $status,
        ':flag_reasons' => $flagReasons,
        ':scan_image'   => $scanImage,
    ]);

}

if (preg_match('#^/scan/session/([a-f0-9\-]+)/sheet$#', $path, $matches) && $method === 'POST') {
    $sessionId = $matches[1];
    require_scan_session($sessionId);
    if (online_scanner_enabled()) {
        json_response(403, ['ok' => false, 'error' => 'Only the paired scanner can upload scans.']);
    }
    store_scan_sheet($sessionId, request_json());
    json_response(200, ['ok' => true]);
}

if (preg_match('#^/scan/session/([a-f0-9\-]+)/results$#', $path, $matches) && $method === 'GET') {
    $sessionId = $matches[1];
    require_scan_session($sessionId);
    $owner = session_educator_id();
    $studentScope = $owner === null ? '' : ' AND st.educator_id = :student_owner';
    $activityScope = $owner === null ? '' :
        ' AND EXISTS (SELECT 1 FROM subjects s WHERE s.id = a.subject_id AND s.educator_id = :activity_owner)';

    $stmt = db()->prepare(
        'SELECT ss.id, ss.sheet_index, ss.student_code, ss.exam_code,
                ss.raw_answers, ss.score, ss.max_score, ss.status,
                ss.flag_reasons, ss.scan_image, ss.created_at,
                st.surname, st.given_name, st.middle_name,
                a.title AS activity_title
         FROM scan_staging ss
         LEFT JOIN students st ON st.student_code = ss.student_code' . $studentScope . '
         LEFT JOIN subject_activities a ON a.exam_code = ss.exam_code' . $activityScope . '
         WHERE ss.session_id = :session_id
         ORDER BY ss.sheet_index ASC'
    );
    $stmt->execute([':session_id' => $sessionId] + ($owner === null ? [] : [
        ':student_owner' => $owner,
        ':activity_owner' => $owner,
    ]));
    $rows = $stmt->fetchAll();

    $sheets = array_map(static function (array $row): array {
        $rawAnswers  = (string) ($row['raw_answers'] ?? '');
        $answerArray = $rawAnswers !== '' ? explode('|', $rawAnswers) : [];

        $flagReasons = [];
        $frJson = (string) ($row['flag_reasons'] ?? '');
        if ($frJson !== '') {
            $decoded = json_decode($frJson, true);
            if (is_array($decoded)) {
                $flagReasons = $decoded;
            }
        }

        $studentName = null;
        if ($row['surname'] !== null) {
            $given  = trim((string) ($row['given_name']  ?? ''));
            $middle = trim((string) ($row['middle_name'] ?? ''));
            $sur    = trim((string) ($row['surname']     ?? ''));
            $mi     = $middle ? $middle[0] . '.' : '';
            $studentName = implode(' ', array_filter([$given, $mi, $sur])) ?: $sur;
        }

        return [
            'id'             => (int) $row['id'],
            'sheet_index'    => (int) $row['sheet_index'],
            'student_code'   => $row['student_code'],
            'student_name'   => $studentName,
            'exam_code'      => $row['exam_code'],
            'activity_title' => $row['activity_title'],
            'raw_answers'    => $answerArray,
            'score'          => $row['score']    !== null ? (int) $row['score']    : null,
            'max_score'      => $row['max_score'] !== null ? (int) $row['max_score'] : null,
            'status'         => (string) $row['status'],
            'flag_reasons'   => $flagReasons,
            'scan_image'     => $row['scan_image'],
        ];
    }, $rows);

    $total        = count($sheets);
    $okCount      = count(array_filter($sheets, static fn($s) => $s['status'] === 'ok'));
    $flaggedCount = $total - $okCount;

    json_response(200, ['ok' => true, 'data' => [
        'sheets'        => $sheets,
        'total'         => $total,
        'ok_count'      => $okCount,
        'flagged_count' => $flaggedCount,
    ]]);
}

if (preg_match('#^/scan/session/([a-f0-9\-]+)/commit$#', $path, $matches) && $method === 'POST') {
    $sessionId   = $matches[1];
    require_scan_session($sessionId);
    $owner = session_educator_id();
    if (online_scanner_enabled()) {
        online_scanner_require_idle($owner, $sessionId);
    }
    $payload     = request_json();
    $sheetsInput = $payload['sheets'] ?? [];

    if (!is_array($sheetsInput)) {
        json_response(400, ['ok' => false, 'error' => 'sheets must be an array']);
    }

    $committed = 0;
    $skipped   = 0;

    foreach ($sheetsInput as $sheetData) {
        $id      = (int) ($sheetData['id']      ?? 0);
        $include = (bool) ($sheetData['include'] ?? false);

        if (!$include) {
            $del = db()->prepare('DELETE FROM scan_staging WHERE id = :id AND session_id = :sid');
            $del->execute([':id' => $id, ':sid' => $sessionId]);
            $skipped++;
            continue;
        }

        $examCode     = trim((string) ($sheetData['exam_code']    ?? ''));
        $studentCode  = trim((string) ($sheetData['student_code'] ?? ''));
        $finalAnswers = (array) ($sheetData['final_answers'] ?? []);

        if ($examCode === '' || $studentCode === '') {
            $skipped++;
            continue;
        }

        $actStmt = db()->prepare(
            'SELECT a.exam_id, e.title AS exam_title, e.total_items, e.answer_key
             FROM subject_activities a
             INNER JOIN exams e ON e.id = a.exam_id
             WHERE a.exam_code = :code' . ($owner === null ? '' : ' AND e.educator_id = :owner') . ' LIMIT 1'
        );
        $actStmt->execute([':code' => $examCode] + ($owner === null ? [] : [':owner' => $owner]));
        $examRow = $actStmt->fetch();

        if (!$examRow) {
            $skipped++;
            continue;
        }

        $examId    = (int)    $examRow['exam_id'];
        $examTitle = (string) $examRow['exam_title'];
        $total     = (int)    $examRow['total_items'];
        $keyItems  = parse_answers_input(strtoupper((string) $examRow['answer_key']));

        $score = 0;
        for ($i = 0; $i < $total; $i++) {
            $ans = strtoupper(trim((string) ($finalAnswers[$i] ?? '')));
            if ($ans !== '' && $ans === ($keyItems[$i] ?? '')) {
                $score++;
            }
        }

        $storedAnswers = implode('|', array_map(
            static fn($a) => strtoupper(trim((string) $a)),
            array_slice($finalAnswers, 0, $total)
        ));

        try {
            db()->beginTransaction();
            $del = db()->prepare('DELETE FROM scan_staging WHERE id = :id AND session_id = :sid');
            $del->execute([':id' => $id, ':sid' => $sessionId]);
            if ($del->rowCount() !== 1) {
                db()->rollBack();
                $skipped++;
                continue;
            }
            $ins = db()->prepare(
                'INSERT INTO submissions (exam_id, exam_title, student_code, answers, score)
                 VALUES (:exam_id, :exam_title, :student_code, :answers, :score)'
            );
            $ins->execute([
                ':exam_id'      => $examId,
                ':exam_title'   => $examTitle,
                ':student_code' => $studentCode,
                ':answers'      => $storedAnswers,
                ':score'        => $score,
            ]);

            db()->commit();
            $committed++;
        } catch (Throwable $e) {
            if (db()->inTransaction()) {
                db()->rollBack();
            }
            $skipped++;
        }
    }

    json_response(200, ['ok' => true, 'data' => [
        'committed' => $committed,
        'skipped'   => $skipped,
    ]]);
}

if (preg_match('#^/scan/session/([a-f0-9\-]+)$#', $path, $matches) && $method === 'DELETE') {
    $sessionId = $matches[1];
    require_scan_session($sessionId);
    if (online_scanner_enabled()) {
        online_scanner_require_idle(session_educator_id(), $sessionId);
    } else {
        scanner_request('/batch-stop', 'POST', ['session_id' => $sessionId, 'wait' => true]);
    }

    $del = db()->prepare('DELETE FROM scan_staging WHERE session_id = :sid');
    $del->execute([':sid' => $sessionId]);
    if (educator_sessions_required()) {
        $deleteSession = db()->prepare('DELETE FROM scan_sessions WHERE id = :id AND educator_id = :owner');
        $deleteSession->execute([':id' => $sessionId, ':owner' => session_educator_id()]);
    }
    json_response(200, ['ok' => true]);
}

json_response(404, ['ok' => false, 'error' => 'Route not found']);
