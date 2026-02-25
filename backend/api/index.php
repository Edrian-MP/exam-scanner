<?php

declare(strict_types=1);

require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/http.php';
require __DIR__ . '/lib/scanner_client.php';

$cfg = app_config();

header('Access-Control-Allow-Origin: ' . $cfg['cors_origin']);
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');

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
                subject_code VARCHAR(40) NOT NULL,
                title VARCHAR(160) NOT NULL,
                term_label VARCHAR(80) NULL,
                description TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_subject_code (subject_code)
            )"
        );
        db()->exec(
            "CREATE TABLE IF NOT EXISTS students (
                id INT AUTO_INCREMENT PRIMARY KEY,
                student_code VARCHAR(64) NOT NULL,
                full_name VARCHAR(180) NOT NULL,
                email VARCHAR(180) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_student_code (student_code)
            )"
        );
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

function find_subject_or_404(int $subjectId): array
{
    $stmt = db()->prepare('SELECT id, subject_code, title, term_label, description, created_at FROM subjects WHERE id = :id LIMIT 1');
    $stmt->execute([':id' => $subjectId]);
    $subject = $stmt->fetch();
    if (!$subject) {
        json_response(404, ['ok' => false, 'error' => 'Subject not found']);
    }
    return $subject;
}

ensure_submissions_exam_title_column();
ensure_lms_schema();

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
    $rows = db()->query(
        'SELECT s.id, s.subject_code, s.title, s.term_label, s.description, s.created_at,
                COUNT(DISTINCT ss.student_id) AS student_count,
                COUNT(DISTINCT a.id) AS activity_count,
                COUNT(DISTINCT CASE WHEN a.publish_status = "published" THEN a.id END) AS published_activity_count
         FROM subjects s
         LEFT JOIN subject_students ss ON ss.subject_id = s.id
         LEFT JOIN subject_activities a ON a.subject_id = s.id
         GROUP BY s.id, s.subject_code, s.title, s.term_label, s.description, s.created_at
         ORDER BY s.created_at DESC'
    )->fetchAll();
    json_response(200, ['ok' => true, 'data' => $rows]);
}

if ($path === '/lms/subjects' && $method === 'POST') {
    $payload = request_json();
    $code = strtoupper(trim((string) ($payload['subject_code'] ?? '')));
    $title = trim((string) ($payload['title'] ?? ''));
    $term = trim((string) ($payload['term_label'] ?? ''));
    $description = trim((string) ($payload['description'] ?? ''));

    if ($code === '' || $title === '') {
        json_response(400, ['ok' => false, 'error' => 'subject_code and title are required']);
    }

    $stmt = db()->prepare(
        'INSERT INTO subjects (subject_code, title, term_label, description)
         VALUES (:subject_code, :title, :term_label, :description)'
    );
    try {
        $stmt->execute([
            ':subject_code' => $code,
            ':title' => $title,
            ':term_label' => $term !== '' ? $term : null,
            ':description' => $description !== '' ? $description : null,
        ]);
    } catch (Throwable $e) {
        json_response(409, ['ok' => false, 'error' => 'Subject code already exists']);
    }

    json_response(201, ['ok' => true, 'data' => ['id' => (int) db()->lastInsertId()]]);
}

if (preg_match('#^/lms/subjects/(\d+)$#', $path, $matches)) {
    $subjectId = (int) $matches[1];
    if ($method === 'DELETE') {
        $stmt = db()->prepare('DELETE FROM subjects WHERE id = :id');
        $stmt->execute([':id' => $subjectId]);
        if ($stmt->rowCount() < 1) {
            json_response(404, ['ok' => false, 'error' => 'Subject not found']);
        }
        json_response(200, ['ok' => true]);
    }
}

if (preg_match('#^/lms/subjects/(\d+)/students$#', $path, $matches)) {
    $subjectId = (int) $matches[1];
    find_subject_or_404($subjectId);

    if ($method === 'GET') {
        $stmt = db()->prepare(
            'SELECT st.id, st.student_code, st.full_name, st.email, ss.enrolled_at
             FROM subject_students ss
             INNER JOIN students st ON st.id = ss.student_id
             WHERE ss.subject_id = :subject_id
             ORDER BY st.full_name ASC'
        );
        $stmt->execute([':subject_id' => $subjectId]);
        json_response(200, ['ok' => true, 'data' => $stmt->fetchAll()]);
    }

    if ($method === 'POST') {
        $payload = request_json();
        $studentCode = strtoupper(trim((string) ($payload['student_code'] ?? '')));
        $fullName = trim((string) ($payload['full_name'] ?? ''));
        $email = trim((string) ($payload['email'] ?? ''));

        if ($studentCode === '' || $fullName === '') {
            json_response(400, ['ok' => false, 'error' => 'student_code and full_name are required']);
        }

        $findStudent = db()->prepare('SELECT id FROM students WHERE student_code = :student_code LIMIT 1');
        $findStudent->execute([':student_code' => $studentCode]);
        $student = $findStudent->fetch();

        if ($student) {
            $studentId = (int) $student['id'];
            $update = db()->prepare(
                'UPDATE students
                 SET full_name = :full_name,
                     email = :email
                 WHERE id = :id'
            );
            $update->execute([
                ':id' => $studentId,
                ':full_name' => $fullName,
                ':email' => $email !== '' ? $email : null,
            ]);
        } else {
            $insertStudent = db()->prepare(
                'INSERT INTO students (student_code, full_name, email)
                 VALUES (:student_code, :full_name, :email)'
            );
            $insertStudent->execute([
                ':student_code' => $studentCode,
                ':full_name' => $fullName,
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
    $subjectId = (int) $matches[1];
    $studentId = (int) $matches[2];
    find_subject_or_404($subjectId);

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
    $subjectId = (int) $matches[1];
    find_subject_or_404($subjectId);

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

if (preg_match('#^/lms/subjects/(\d+)/announcements$#', $path, $matches)) {
    $subjectId = (int) $matches[1];
    find_subject_or_404($subjectId);

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

if (preg_match('#^/lms/subjects/(\d+)/gradebook$#', $path, $matches) && $method === 'GET') {
    $subjectId = (int) $matches[1];
    find_subject_or_404($subjectId);

    $stmt = db()->prepare(
        'SELECT st.id AS student_id,
                st.student_code,
                st.full_name,
                COUNT(DISTINCT CASE WHEN a.publish_status = "published" THEN a.id END) AS published_activities,
                COUNT(DISTINCT CASE WHEN a.publish_status = "published" AND sub.id IS NOT NULL THEN a.id END) AS completed_activities,
                ROUND(AVG(
                    CASE
                        WHEN sub.id IS NULL OR ex.total_items IS NULL OR ex.total_items = 0 THEN NULL
                        ELSE (sub.score / ex.total_items) * 100
                    END
                ), 2) AS average_percent
         FROM subject_students ss
         INNER JOIN students st ON st.id = ss.student_id
         LEFT JOIN subject_activities a
            ON a.subject_id = ss.subject_id
            AND a.activity_type = "exam"
            AND a.exam_id IS NOT NULL
         LEFT JOIN exams ex ON ex.id = a.exam_id
         LEFT JOIN submissions sub
            ON sub.exam_id = a.exam_id
            AND sub.student_code = st.student_code
         WHERE ss.subject_id = :subject_id
         GROUP BY st.id, st.student_code, st.full_name
         ORDER BY st.full_name ASC'
    );
    $stmt->execute([':subject_id' => $subjectId]);
    json_response(200, ['ok' => true, 'data' => $stmt->fetchAll()]);
}

json_response(404, ['ok' => false, 'error' => 'Route not found']);
