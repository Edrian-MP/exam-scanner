<?php

declare(strict_types=1);

require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/http.php';
require __DIR__ . '/lib/scanner_client.php';

$cfg = app_config();

header('Access-Control-Allow-Origin: ' . $cfg['cors_origin']);
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');

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

ensure_submissions_exam_title_column();

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

json_response(404, ['ok' => false, 'error' => 'Route not found']);
