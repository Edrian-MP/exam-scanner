<?php

declare(strict_types=1);

const ONLINE_SCANNER_HEARTBEAT_SECONDS = 40;

function online_scanner_enabled(): bool
{
    return app_config()['online_scanner'] && educator_sessions_required() && db_is_postgres();
}

function online_scanner_query(string $sql, array $parameters): PDOStatement
{
    $statement = db()->prepare($sql);
    $statement->execute($parameters);
    return $statement;
}

function online_scanner_transaction(callable $operation): array
{
    $connection = db();
    $connection->beginTransaction();
    try {
        $result = $operation();
        $connection->commit();
        return $result;
    } catch (Throwable $error) {
        $connection->rollBack();
        throw $error;
    }
}

function online_scanner_device(string $column, $value, bool $lock = false): ?array
{
    $predicate = $column === 'token_hash' ? 'd.token_hash' : 'd.educator_id';
    $statement = online_scanner_query(
        'SELECT d.*, COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - d.last_seen_at)), 100000) AS age
         FROM online_scanners d JOIN educators e ON e.id = d.educator_id AND e.is_active = 1
         WHERE ' . $predicate . ' = :value' . ($lock ? ' FOR UPDATE OF d' : ''),
        ['value' => $value]
    );
    return $statement->fetch() ?: null;
}

function online_scanner_recent(?array $device): bool
{
    return $device !== null && (float) $device['age'] < ONLINE_SCANNER_HEARTBEAT_SECONDS;
}

function online_scanner_job(int $owner, ?string $sessionId = null, bool $activeOnly = false): ?array
{
    $params = ['owner' => $owner];
    $sql = 'SELECT * FROM online_scan_jobs WHERE educator_id = :owner';
    if ($sessionId !== null) {
        $sql .= ' AND session_id = :session_id';
        $params['session_id'] = $sessionId;
    }
    if ($activeOnly) {
        $sql .= " AND phase <> 'finished'";
    }
    $statement = online_scanner_query(
        $sql . " ORDER BY (phase <> 'finished') DESC, created_at DESC LIMIT 1",
        $params
    );
    return $statement->fetch() ?: null;
}

function online_scanner_finish(int $owner, string $sessionId, string $reason, string $message): void
{
    online_scanner_query(
        "UPDATE online_scan_jobs SET phase = 'finished', waiting_for_paper = false, activity = NULL, feed_attempt = NULL,
             finish_reason = :reason, finish_message = :message
         WHERE educator_id = :owner AND session_id = :session_id AND phase <> 'finished'",
        ['owner' => $owner, 'session_id' => $sessionId, 'reason' => $reason, 'message' => $message]
    );
}

function online_scanner_expire(int $owner, ?array $device): void
{
    if (!online_scanner_recent($device)) {
        $job = online_scanner_job($owner, null, true);
        if ($job !== null) {
            online_scanner_finish($owner, $job['session_id'], 'disconnected', 'Scanner PC stopped responding.');
        }
    }
}

function online_scanner_status(int $owner, ?string $sessionId): array
{
    $device = online_scanner_device('educator_id', $owner);
    $job = online_scanner_job($owner, $sessionId);
    $recent = online_scanner_recent($device);
    $running = $recent && $job !== null && $job['phase'] !== 'finished';
    $reviewSessionId = null;
    if (!$running && $sessionId === null) {
        $results = online_scanner_query(
            'SELECT j.* FROM online_scan_jobs j
             WHERE j.educator_id = :owner AND EXISTS (
                 SELECT 1 FROM scan_staging s WHERE s.session_id = j.session_id
             )
             ORDER BY j.created_at DESC LIMIT 1',
            ['owner' => $owner]
        )->fetch();
        if ($results) {
            $job = $results;
            $reviewSessionId = $job['session_id'];
        }
    }

    return [
        'paired' => $device !== null,
        'online' => $recent,
        'connected' => $recent && (bool) $device['scanner_ready'],
        'arduino' => $recent && (bool) $device['arduino_ready'],
        'batch_running' => $running,
        'active_session_id' => $running ? $job['session_id'] : null,
        'review_session_id' => $reviewSessionId,
        'single' => $job !== null && (bool) $job['single_sheet'],
        'stop_requested' => $running && $job['phase'] === 'stopping',
        'waiting_for_paper' => $running && (bool) $job['waiting_for_paper'],
        'activity' => $running ? $job['activity'] : null,
        'feed_attempt' => $running ? $job['feed_attempt'] : null,
        'last_batch_session_id' => $running ? null : ($job['session_id'] ?? null),
        'last_batch_reason' => $running || $job === null ? null :
            ($job['phase'] === 'finished' ? $job['finish_reason'] : 'disconnected'),
        'last_batch_message' => $running || $job === null ? null :
            ($job['phase'] === 'finished' ? $job['finish_message'] : 'Scanner PC stopped responding.'),
    ];
}

function online_scanner_pair(int $owner): array
{
    return online_scanner_transaction(function () use ($owner) {
        // Serialize first pairing as well as replacement of an existing token.
        online_scanner_query('SELECT id FROM educators WHERE id = :owner FOR UPDATE', ['owner' => $owner]);
        $device = online_scanner_device('educator_id', $owner, true);
        online_scanner_expire($owner, $device);
        if (online_scanner_job($owner, null, true) !== null) {
            return [409, ['ok' => false, 'error' => 'Stop the current scan before replacing the scanner code.']];
        }
        $token = bin2hex(random_bytes(32));
        online_scanner_query(
            'INSERT INTO online_scanners (educator_id, token_hash) VALUES (:owner, :token)
             ON CONFLICT (educator_id) DO UPDATE SET token_hash = EXCLUDED.token_hash,
                 worker_id = NULL, last_seen_at = NULL, scanner_ready = false, arduino_ready = false',
            ['owner' => $owner, 'token' => hash('sha256', $token)]
        );
        return [200, ['ok' => true, 'data' => ['token' => $token]]];
    });
}

function online_scanner_queue(int $owner, string $sessionId, bool $single): array
{
    return online_scanner_transaction(function () use ($owner, $sessionId, $single) {
        $device = online_scanner_device('educator_id', $owner, true);
        online_scanner_expire($owner, $device);
        if (!online_scanner_recent($device) || !(bool) $device['scanner_ready']) {
            return [409, ['ok' => false, 'error' => 'The scanner PC is offline or its scanner driver is unavailable.']];
        }
        if (!$single && !(bool) $device['arduino_ready']) {
            return [409, ['ok' => false, 'error' => 'The Arduino feeder is unavailable. Try Single Scan.']];
        }
        if (!scan_session_owned_by($sessionId, $owner)) {
            return [404, ['ok' => false, 'error' => 'Scan session not found']];
        }
        $existing = online_scanner_job($owner, null, true);
        if ($existing !== null && $existing['session_id'] === $sessionId && (bool) $existing['single_sheet'] === $single) {
            return [200, ['ok' => true]];
        }
        if ($existing !== null || online_scanner_job($owner, $sessionId) !== null) {
            return [409, ['ok' => false, 'error' => 'A scan is already running or this scan session has already been used.']];
        }
        online_scanner_query(
            "INSERT INTO online_scan_jobs (session_id, educator_id, single_sheet, phase)
             VALUES (:session_id, :owner, :single, 'queued')",
            ['session_id' => $sessionId, 'owner' => $owner, 'single' => $single ? 'true' : 'false']
        );
        return [200, ['ok' => true]];
    });
}

function online_scanner_stop(int $owner, string $sessionId): array
{
    return online_scanner_transaction(function () use ($owner, $sessionId) {
        $device = online_scanner_device('educator_id', $owner, true);
        online_scanner_expire($owner, $device);
        $job = online_scanner_job($owner, $sessionId, true);
        if ($job === null) {
            return [200, ['ok' => true, 'data' => ['idle' => true]]];
        }
        if ($job['phase'] === 'queued') {
            online_scanner_finish($owner, $sessionId, 'stopped', 'Scan stopped before the feeder started.');
            return [200, ['ok' => true, 'data' => ['idle' => true]]];
        }
        online_scanner_query(
            "UPDATE online_scan_jobs SET phase = 'stopping' WHERE educator_id = :owner AND session_id = :session_id",
            ['owner' => $owner, 'session_id' => $sessionId]
        );
        return [200, ['ok' => true, 'data' => ['idle' => false]]];
    });
}

function online_scanner_require_idle(int $owner, string $sessionId): void
{
    [$idle] = online_scanner_transaction(function () use ($owner, $sessionId) {
        $device = online_scanner_device('educator_id', $owner, true);
        online_scanner_expire($owner, $device);
        return [online_scanner_job($owner, $sessionId, true) === null];
    });
    if (!$idle) {
        json_response(409, ['ok' => false, 'error' => 'Wait for the scanner to finish or stop the scan first.']);
    }
}

function online_scanner_poll(int $owner, string $worker, array $payload): array
{
    online_scanner_query(
        'UPDATE online_scanners SET worker_id = :worker, last_seen_at = CURRENT_TIMESTAMP,
             scanner_ready = :scanner, arduino_ready = :arduino WHERE educator_id = :owner',
        [
            'worker' => $worker, 'owner' => $owner,
            'scanner' => ($payload['scanner_ready'] ?? null) === true ? 'true' : 'false',
            'arduino' => ($payload['arduino_ready'] ?? null) === true ? 'true' : 'false',
        ]
    );

    $job = online_scanner_job($owner, null, true);
    if ($job === null) {
        return [200, ['ok' => true, 'data' => ['job' => null]]];
    }
    $sessionId = $job['session_id'];
    if ($job['phase'] !== 'queued' && ($payload['last_batch_session_id'] ?? null) === $sessionId) {
        $reason = $payload['last_batch_reason'] ?? null;
        $message = $payload['last_batch_message'] ?? null;
        online_scanner_finish(
            $owner, $sessionId, is_string($reason) && preg_match('/^[a-z_]{1,40}$/D', $reason) ? $reason : 'failed',
            is_string($message) && preg_match('/^[\x20-\x7E]{1,240}$/D', $message) ? $message : 'Scan ended.'
        );
        return [200, ['ok' => true, 'data' => ['job' => null]]];
    }
    $reportMatchesJob = ($payload['active_session_id'] ?? null) === $sessionId;
    $activity = $reportMatchesJob ? ($payload['activity'] ?? null) : null;
    if (!in_array($activity, ['connecting_feeder', 'feeding', 'scanning', 'processing'], true)) {
        $activity = null;
    }
    $feedAttempt = $payload['feed_attempt'] ?? null;
    if ($activity !== 'feeding' || !is_int($feedAttempt) || $feedAttempt < 1 || $feedAttempt > 3) {
        $feedAttempt = null;
    }
    online_scanner_query(
        "UPDATE online_scan_jobs SET phase = CASE WHEN phase = 'queued' THEN 'scanning' ELSE phase END,
             waiting_for_paper = :waiting, activity = :activity, feed_attempt = :feed_attempt
         WHERE educator_id = :owner AND session_id = :session_id",
        [
            'owner' => $owner, 'session_id' => $sessionId,
            'waiting' => $reportMatchesJob && ($payload['waiting_for_paper'] ?? null) === true ? 'true' : 'false',
            'activity' => $activity, 'feed_attempt' => $feedAttempt,
        ]
    );

    return [200, ['ok' => true, 'data' => ['job' => [
        'session_id' => $sessionId,
        'single' => (bool) $job['single_sheet'],
        'stop' => $job['phase'] === 'stopping',
    ]]]];
}

function online_scanner_handle_device(string $path, string $method): void
{
    if (!online_scanner_enabled()) {
        json_response(404, ['ok' => false, 'error' => 'Route not found']);
    }
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    $worker = $_SERVER['HTTP_X_SCANNER_WORKER'] ?? '';
    if (!preg_match('/^Bearer ([a-f0-9]{64})$/D', $auth, $match) || !preg_match('/^[a-f0-9]{32}$/D', $worker)) {
        json_response(401, ['ok' => false, 'error' => 'Scanner credentials required.']);
    }
    $tokenHash = hash('sha256', $match[1]);
    $payload = $method === 'POST' ? request_json() : [];
    [$status, $response] = online_scanner_transaction(function () use ($path, $method, $worker, $tokenHash, $payload) {
        $device = online_scanner_device('token_hash', $tokenHash, true);
        if ($device === null) {
            return [401, ['ok' => false, 'error' => 'Invalid scanner code. Pair the scanner PC again.']];
        }
        $owner = (int) $device['educator_id'];
        $recent = online_scanner_recent($device);
        if ($recent && $device['worker_id'] !== $worker) {
            return [409, ['ok' => false, 'error' => 'This scanner code is already in use by another worker.']];
        }
        if ($path === '/scanner/device/poll' && $method === 'POST') {
            online_scanner_expire($owner, $device);
            return online_scanner_poll($owner, $worker, $payload);
        }
        if (!$recent || $device['worker_id'] !== $worker ||
            !preg_match('#^/scanner/device/session/([a-f0-9-]{36})/(sheet|exam-code/([0-9]{6}))$#D', $path, $route)) {
            return [404, ['ok' => false, 'error' => 'Active scan session not found.']];
        }
        $job = online_scanner_job($owner, $route[1], true);
        if ($job === null || $job['phase'] === 'queued') {
            return [404, ['ok' => false, 'error' => 'Active scan session not found.']];
        }
        if ($method === 'GET' && isset($route[3])) {
            $data = exam_code_data($route[3], $owner);
            return $data === null
                ? [404, ['ok' => false, 'error' => 'Exam code not found']]
                : [200, ['ok' => true, 'data' => $data]];
        }
        if ($method === 'POST' && $route[2] === 'sheet') {
            $sheetIndex = $payload['sheet_index'] ?? null;
            $image = $payload['scan_image'] ?? '';
            if (!is_int($sheetIndex) || $sheetIndex < 1 || !is_string($image) || strlen($image) > 2000000) {
                return [400, ['ok' => false, 'error' => 'Invalid scanned sheet.']];
            }
            $existing = online_scanner_query(
                'SELECT 1 FROM scan_staging WHERE session_id = :session_id AND sheet_index = :sheet_index',
                ['session_id' => $route[1], 'sheet_index' => $sheetIndex]
            );
            if (!$existing->fetchColumn()) {
                store_scan_sheet($route[1], $payload);
            }
            return [200, ['ok' => true]];
        }
        return [405, ['ok' => false, 'error' => 'Method not allowed']];
    });
    json_response($status, $response);
}
