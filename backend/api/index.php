<?php

declare(strict_types=1);

require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/http.php';
require __DIR__ . '/lib/scanner_client.php';

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

function normalize_answer_token(string $token): string
{
    $upper = strtoupper(trim($token));
    $upper = preg_replace('/\s+/', '', $upper) ?? '';
    $upper = preg_replace('/[^A-Z\/]/', '', $upper) ?? '';
    $upper = preg_replace('/\/+/', '/', $upper) ?? '';
    $upper = trim($upper, '/');
    return $upper;
}

function parse_answers_input(string $raw): array
{
    $raw = trim($raw);
    if ($raw === '') {
        return [];
    }

    $hasLineBreaks = str_contains($raw, "\n") || str_contains($raw, "\r");
    if ($hasLineBreaks) {
        $lines = preg_split('/\R+/', $raw) ?: [];
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

    $normalized = normalize_answer_token($raw);
    if ($normalized === '') {
        return [];
    }

    if (!str_contains($normalized, '/')) {
        return str_split($normalized);
    }

    $parts = preg_split('/[|,\s;]+/', $raw) ?: [];
    $items = [];
    foreach ($parts as $part) {
        $token = normalize_answer_token($part);
        if ($token !== '') {
            $items[] = $token;
        }
    }
    return $items;
}

function is_valid_answer_token(string $token): bool
{
    return (bool) preg_match('/^[A-Z](\/[A-Z])+$/', $token) || (bool) preg_match('/^[A-Z]$/', $token);
}

function normalize_answers_for_store(array $items): string
{
    return implode('|', $items);
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
                max_score INT NOT NULL DEFAULT 100,
                due_at DATETIME NULL,
                publish_status VARCHAR(16) NOT NULL DEFAULT 'draft',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_subject_activities_subject_id (subject_id),
                INDEX idx_subject_activities_exam_id (exam_id),
                CONSTRAINT fk_subject_activities_subject FOREIGN KEY (subject_id) REFERENCES subjects(id)
                    ON DELETE CASCADE
                    ON UPDATE CASCADE,
                CONSTRAINT fk_subject_activities_exam FOREIGN KEY (exam_id) REFERENCES exams(id)
                    ON DELETE SET NULL
                    ON UPDATE CASCADE
            )"
        );
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
        if ($count < 1) {
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
    $educatorId = (int) ($_GET['educator_id'] ?? 0);
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

ensure_submissions_exam_title_column();
ensure_educators_schema();
ensure_lms_schema();

if ($path === '/auth/account' && $method === 'GET') {
    $educatorId = (int) ($_GET['educator_id'] ?? 0);
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
    $educatorId = (int) ($payload['educator_id'] ?? 0);
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

    $existsStmt = db()->prepare('SELECT id FROM educators WHERE email = :email LIMIT 1');
    $existsStmt->execute([':email' => $email]);
    if ($existsStmt->fetch()) {
        json_response(409, ['ok' => false, 'error' => 'An educator with this email already exists']);
    }

    $insert = db()->prepare(
        'INSERT INTO educators (surname, email, password_hash, is_active)
         VALUES (:surname, :email, :password_hash, 1)'
    );
    $insert->execute([
        ':surname' => $fullName,
        ':email' => $email,
        ':password_hash' => password_hash($password, PASSWORD_DEFAULT),
    ]);

    json_response(201, [
        'ok' => true,
        'data' => [
            'educator' => [
                'id' => (int) db()->lastInsertId(),
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
    $scanner = scanner_request('/status');
    json_response(200, [
        'ok' => true,
        'transport' => 'php->python-local',
        'scanner' => $scanner['data']['scanner'] ?? ['connected' => false],
    ]);
}

if ($path === '/scanner/scan') {
    ensure_method('POST');
    $payload = request_json();
    if (empty($payload['exam_id'])) {
        json_response(400, ['ok' => false, 'error' => 'exam_id is required']);
    }

    $scanResult = scanner_request('/scan', 'POST', ['exam_id' => (int) $payload['exam_id']]);
    if (!($scanResult['ok'] ?? false)) {
        json_response(502, ['ok' => false, 'error' => $scanResult['error'] ?? 'Scan failed']);
    }

    $stmt = db()->prepare('INSERT INTO scan_jobs (exam_id, status, raw_payload) VALUES (:exam_id, :status, :raw_payload)');
    $stmt->execute([
        ':exam_id' => (int) $payload['exam_id'],
        ':status' => 'completed',
        ':raw_payload' => json_encode($scanResult['data'] ?? []),
    ]);

    json_response(200, [
        'ok' => true,
        'data' => [
            'job_id' => (int) db()->lastInsertId(),
            'scan' => $scanResult['data'] ?? [],
        ],
    ]);
}

if ($path === '/exams' && ($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    $rows = db()->query('SELECT id, title, total_items, answer_key, created_at FROM exams ORDER BY id DESC LIMIT 30')->fetchAll();
    json_response(200, ['ok' => true, 'data' => $rows]);
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
            json_response(400, ['ok' => false, 'error' => 'Invalid answer_key format. Use A or A/B per item.']);
        }
    }

    $storedAnswerKey = normalize_answers_for_store($keyItems);

    $stmt = db()->prepare('INSERT INTO exams (title, total_items, answer_key) VALUES (:title, :total_items, :answer_key)');
    $stmt->execute([
        ':title' => $title,
        ':total_items' => $totalItems,
        ':answer_key' => $storedAnswerKey,
    ]);

    json_response(201, ['ok' => true, 'data' => ['id' => (int) db()->lastInsertId()]]);
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

    $stmt = db()->prepare('SELECT id, title, total_items, answer_key FROM exams WHERE id = :id LIMIT 1');
    $stmt->execute([':id' => $examId]);
    $exam = $stmt->fetch();
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
            json_response(400, ['ok' => false, 'error' => 'Invalid answers format. Use A or A/B per item.']);
        }
    }

    $score = 0;

    for ($i = 0; $i < $total; $i++) {
        $student = $answerItems[$i] ?? '';
        $correct = $keyItems[$i] ?? '';
        $studentOptions = array_filter(explode('/', $student));
        $correctOptions = array_filter(explode('/', $correct));
        if (count(array_intersect($studentOptions, $correctOptions)) > 0) {
            $score++;
        }
    }

    $storedAnswers = normalize_answers_for_store($answerItems);

    $examTitle = trim((string) ($exam['title'] ?? ''));
    $insert = db()->prepare(
        'INSERT INTO submissions (exam_id, exam_title, student_code, answers, score) VALUES (:exam_id, :exam_title, :student_code, :answers, :score)'
    );
    $insert->execute([
        ':exam_id' => $examId,
        ':exam_title' => $examTitle,
        ':student_code' => $studentCode,
        ':answers' => $storedAnswers,
        ':score' => $score,
    ]);

    json_response(200, [
        'ok' => true,
        'data' => [
            'submission_id' => (int) db()->lastInsertId(),
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
                COUNT(DISTINCT CASE WHEN a.publish_status = "published" THEN a.id END) AS published_activity_count
         FROM subjects s
         LEFT JOIN subject_students ss ON ss.subject_id = s.id
         LEFT JOIN subject_activities a ON a.subject_id = s.id
         WHERE s.educator_id = :educator_id
         GROUP BY s.id, s.subject_code, s.title, s.term_label, s.description, s.created_at
         ORDER BY s.created_at DESC'
    );
    $stmt->execute([':educator_id' => $educatorId]);
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

    $stmt = db()->prepare(
        'INSERT INTO subjects (educator_id, subject_code, title, term_label, description)
         VALUES (:educator_id, :subject_code, :title, :term_label, :description)'
    );
    try {
        $stmt->execute([
            ':educator_id' => $educatorId,
            ':subject_code' => $code,
            ':title' => $title,
            ':term_label' => $term !== '' ? $term : null,
            ':description' => $description !== '' ? $description : null,
        ]);
    } catch (Throwable $e) {
        json_response(409, ['ok' => false, 'error' => 'Subject code already exists for this educator']);
    }

    json_response(201, ['ok' => true, 'data' => ['id' => (int) db()->lastInsertId()]]);
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

        $findStudent = db()->prepare('SELECT id FROM students WHERE student_code = :student_code LIMIT 1');
        $findStudent->execute([':student_code' => $studentCode]);
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
            $insertStudent = db()->prepare(
                'INSERT INTO students (student_code, surname, given_name, middle_name, email)
                 VALUES (:student_code, :surname, :given_name, :middle_name, :email)'
            );
            $insertStudent->execute([
                ':student_code' => $studentCode,
                ':surname' => $surname,
                ':given_name' => $givenName !== '' ? $givenName : null,
                ':middle_name' => $middleName !== '' ? $middleName : null,
                ':email' => $email !== '' ? $email : null,
            ]);
            $studentId = (int) db()->lastInsertId();
        }

        $link = db()->prepare(
            'INSERT IGNORE INTO subject_students (subject_id, student_id)
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
            'SELECT a.id, a.subject_id, a.title, a.activity_type, a.exam_id, a.max_score, a.due_at, a.publish_status, a.created_at,
                    e.title AS exam_title,
                    COUNT(DISTINCT CASE WHEN sub.id IS NOT NULL THEN sub.id END) AS submission_count
             FROM subject_activities a
             LEFT JOIN exams e ON e.id = a.exam_id
             LEFT JOIN submissions sub ON sub.exam_id = a.exam_id
             WHERE a.subject_id = :subject_id
             GROUP BY a.id, a.subject_id, a.title, a.activity_type, a.exam_id, a.max_score, a.due_at, a.publish_status, a.created_at, e.title
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

        if ($maxScore < 1) {
            $maxScore = 100;
        }

        if ($examId > 0) {
            $examStmt = db()->prepare('SELECT id FROM exams WHERE id = :id LIMIT 1');
            $examStmt->execute([':id' => $examId]);
            if (!$examStmt->fetch()) {
                json_response(404, ['ok' => false, 'error' => 'Linked exam not found']);
            }
        } else {
            $examId = null;
        }

        $insert = db()->prepare(
            'INSERT INTO subject_activities (subject_id, title, activity_type, exam_id, max_score, due_at, publish_status)
             VALUES (:subject_id, :title, :activity_type, :exam_id, :max_score, :due_at, :publish_status)'
        );
        $insert->execute([
            ':subject_id' => $subjectId,
            ':title' => $title,
            ':activity_type' => $activityType,
            ':exam_id' => $examId,
            ':max_score' => $maxScore,
            ':due_at' => $dueAt !== '' ? $dueAt : null,
            ':publish_status' => $publishStatus,
        ]);

        json_response(201, ['ok' => true, 'data' => ['id' => (int) db()->lastInsertId()]]);
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

        if ($maxScore < 1) {
            $maxScore = 100;
        }

        if ($examId > 0) {
            $examStmt = db()->prepare('SELECT id FROM exams WHERE id = :id LIMIT 1');
            $examStmt->execute([':id' => $examId]);
            if (!$examStmt->fetch()) {
                json_response(404, ['ok' => false, 'error' => 'Linked exam not found']);
            }
        } else {
            $examId = null;
        }

        $update = db()->prepare(
            'UPDATE subject_activities
             SET title = :title,
                 activity_type = :activity_type,
                 exam_id = :exam_id,
                 max_score = :max_score,
                 due_at = :due_at,
                 publish_status = :publish_status
             WHERE id = :id AND subject_id = :subject_id'
        );
        $update->execute([
            ':id' => $activityId,
            ':subject_id' => $subjectId,
            ':title' => $title,
            ':activity_type' => $activityType,
            ':exam_id' => $examId,
            ':max_score' => $maxScore,
            ':due_at' => $dueAt !== '' ? $dueAt : null,
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

        $stmt = db()->prepare(
            'INSERT INTO subject_announcements (subject_id, title, body)
             VALUES (:subject_id, :title, :body)'
        );
        $stmt->execute([
            ':subject_id' => $subjectId,
            ':title' => $title,
            ':body' => $body,
        ]);

        json_response(201, ['ok' => true, 'data' => ['id' => (int) db()->lastInsertId()]]);
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

if (preg_match('#^/lms/subjects/(\d+)/gradebook$#', $path, $matches) && $method === 'GET') {
    $educatorId = require_lms_educator_id();
    $subjectId = (int) $matches[1];
    find_subject_or_404($subjectId, $educatorId);

    $studentsStmt = db()->prepare(
        'SELECT st.id AS student_id,
                st.student_code,
                st.surname,
                st.given_name,
                st.middle_name
         FROM subject_students ss
         INNER JOIN students st ON st.id = ss.student_id
         WHERE ss.subject_id = :subject_id
         ORDER BY st.surname ASC, st.given_name ASC, st.middle_name ASC'
    );
    $studentsStmt->execute([':subject_id' => $subjectId]);
    $students = $studentsStmt->fetchAll();

    $publishedStmt = db()->prepare(
        'SELECT a.id AS activity_id,
                a.title,
                a.activity_type,
                a.exam_id,
                a.max_score,
                a.due_at,
                a.created_at,
                ex.total_items
         FROM subject_activities a
         LEFT JOIN exams ex ON ex.id = a.exam_id
         WHERE a.subject_id = :subject_id
           AND a.publish_status = "published"
         ORDER BY COALESCE(a.due_at, a.created_at) ASC, a.id ASC'
    );
    $publishedStmt->execute([':subject_id' => $subjectId]);
    $publishedActivities = array_map(static function (array $row): array {
        return [
            'activity_id' => (int) ($row['activity_id'] ?? 0),
            'title' => (string) ($row['title'] ?? ''),
            'activity_type' => (string) ($row['activity_type'] ?? 'activity'),
            'exam_id' => isset($row['exam_id']) ? (int) $row['exam_id'] : null,
            'max_score' => (int) ($row['max_score'] ?? 0),
            'due_at' => $row['due_at'] ?? null,
            'total_items' => isset($row['total_items']) ? (int) $row['total_items'] : null,
        ];
    }, $publishedStmt->fetchAll());

    $scoredExamIds = [];
    foreach ($publishedActivities as $activity) {
        if (($activity['exam_id'] ?? null) !== null) {
            $scoredExamIds[(int) $activity['exam_id']] = true;
        }
    }
    $scoredExamIds = array_values(array_map('intval', array_keys($scoredExamIds)));

    $scoresByStudent = [];
    if (count($scoredExamIds) > 0) {
        $placeholders = implode(',', array_fill(0, count($scoredExamIds), '?'));
        $scoresSql = sprintf(
            'SELECT s.student_code, s.exam_id, MAX(s.score) AS best_score
             FROM submissions s
             WHERE s.exam_id IN (%s)
             GROUP BY s.student_code, s.exam_id',
            $placeholders
        );
        $scoresStmt = db()->prepare($scoresSql);
        $scoresStmt->execute($scoredExamIds);
        foreach ($scoresStmt->fetchAll() as $scoreRow) {
            $studentCode = strtoupper(trim((string) ($scoreRow['student_code'] ?? '')));
            $examId = (int) ($scoreRow['exam_id'] ?? 0);
            $bestScore = (int) ($scoreRow['best_score'] ?? 0);
            if ($studentCode === '' || $examId < 1) {
                continue;
            }
            if (!isset($scoresByStudent[$studentCode])) {
                $scoresByStudent[$studentCode] = [];
            }
            $scoresByStudent[$studentCode][$examId] = $bestScore;
        }
    }

    $rows = [];
    foreach ($students as $student) {
        $studentCodeRaw = (string) ($student['student_code'] ?? '');
        $studentCode = strtoupper(trim($studentCodeRaw));
        $studentScores = $scoresByStudent[$studentCode] ?? [];

        $publishedCount = count($publishedActivities);
        $completedCount = 0;
        $percentSum = 0.0;
        $details = [];

        foreach ($publishedActivities as $activity) {
            $examId = $activity['exam_id'];
            $totalItems = $activity['total_items'];
            $score = null;
            $percent = null;
            $status = 'posted';

            if ($examId !== null && isset($studentScores[(int) $examId])) {
                $score = (int) $studentScores[(int) $examId];
                $status = 'checked';
                $completedCount++;
            } elseif ($examId !== null) {
                $status = 'pending';
            }

            $activityTotalItems = 0;
            if ($totalItems !== null && (int) $totalItems > 0) {
                $activityTotalItems = (int) $totalItems;
            } elseif ((int) ($activity['max_score'] ?? 0) > 0) {
                // Fallback for activities without linked exam total_items.
                $activityTotalItems = (int) $activity['max_score'];
            }

            if ($activityTotalItems > 0) {
                $percent = round((max(0, min((int) ($score ?? 0), $activityTotalItems)) / $activityTotalItems) * 100, 2);
            }
            $percentSum += (float) ($percent ?? 0.0);

            $details[] = [
                'activity_id' => (int) $activity['activity_id'],
                'title' => (string) $activity['title'],
                'activity_type' => (string) $activity['activity_type'],
                'exam_id' => $examId,
                'max_score' => (int) $activity['max_score'],
                'total_items' => $totalItems,
                'status' => $status,
                'score' => $score,
                'percent' => $percent,
            ];
        }

        $averagePercent = $publishedCount > 0
            ? round($percentSum / $publishedCount, 2)
            : null;

        $rows[] = [
            'student_id' => (int) ($student['student_id'] ?? 0),
            'student_code' => $studentCodeRaw,
            'surname' => (string) ($student['surname'] ?? ''),
            'given_name' => (string) ($student['given_name'] ?? ''),
            'middle_name' => (string) ($student['middle_name'] ?? ''),
            'published_activities' => $publishedCount,
            'completed_activities' => $completedCount,
            'average_percent' => $averagePercent,
            'published_details' => $details,
        ];
    }

    json_response(200, [
        'ok' => true,
        'data' => [
            'rows' => $rows,
            'published_activities' => $publishedActivities,
        ],
    ]);
}

json_response(404, ['ok' => false, 'error' => 'Route not found']);
