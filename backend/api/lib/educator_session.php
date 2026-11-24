<?php

declare(strict_types=1);

const EDUCATOR_SESSION_COOKIE = '__Host-exam_scanner_session';
const EDUCATOR_SESSION_SECONDS = 43200;

function educator_sessions_required(): bool
{
    return app_config()['require_educator_session'];
}

function educator_session_token_hash(): ?string
{
    $token = $_COOKIE[EDUCATOR_SESSION_COOKIE] ?? null;
    return is_string($token) && preg_match('/^[a-f0-9]{64}$/D', $token)
        ? hash('sha256', $token)
        : null;
}

function educator_session_user_id(): ?int
{
    static $educatorId = false;
    if ($educatorId !== false) {
        return $educatorId;
    }

    $tokenHash = educator_session_token_hash();
    if ($tokenHash === null) {
        return $educatorId = null;
    }
    $stmt = db()->prepare(
        'SELECT e.id
         FROM educator_sessions s
         JOIN educators e ON e.id = s.educator_id
         WHERE s.token_hash = :token AND s.expires_at > CURRENT_TIMESTAMP AND e.is_active = 1'
    );
    $stmt->execute([':token' => $tokenHash]);
    $id = $stmt->fetchColumn();
    return $educatorId = $id === false ? null : (int) $id;
}

function session_educator_id(): ?int
{
    if (!educator_sessions_required()) {
        return null;
    }
    $educatorId = educator_session_user_id();
    if ($educatorId === null) {
        json_response(401, ['ok' => false, 'error' => 'Sign in to continue.', 'code' => 'session_required']);
    }
    return $educatorId;
}

function scoped_educator_id(int $requested): int
{
    $educatorId = session_educator_id();
    if ($educatorId !== null && $requested !== 0 && $requested !== $educatorId) {
        json_response(403, ['ok' => false, 'error' => 'Access denied']);
    }
    return $educatorId ?? $requested;
}

function write_educator_session_cookie(string $token, int $expiresAt): void
{
    setcookie(EDUCATOR_SESSION_COOKIE, $token, [
        'expires' => $expiresAt,
        'path' => '/',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function revoke_current_educator_session(): void
{
    $tokenHash = educator_session_token_hash();
    if ($tokenHash !== null) {
        $stmt = db()->prepare('DELETE FROM educator_sessions WHERE token_hash = :token');
        $stmt->execute([':token' => $tokenHash]);
    }
}

function create_educator_session(int $educatorId): void
{
    if (!educator_sessions_required()) {
        return;
    }
    $token = bin2hex(random_bytes(32));
    $expiresAt = time() + EDUCATOR_SESSION_SECONDS;
    $stmt = db()->prepare(
        'INSERT INTO educator_sessions (token_hash, educator_id, expires_at)
         VALUES (:token, :educator, to_timestamp(:expires_at))'
    );
    $stmt->execute([
        ':token' => hash('sha256', $token),
        ':educator' => $educatorId,
        ':expires_at' => $expiresAt,
    ]);
    revoke_current_educator_session();
    db()->exec('DELETE FROM educator_sessions WHERE expires_at <= CURRENT_TIMESTAMP');
    write_educator_session_cookie($token, $expiresAt);
}

function limit_educator_auth_attempts(string $scope, int $limit, int $seconds): void
{
    if (!educator_sessions_required()) {
        return;
    }
    $now = time();
    $bucket = $now - $now % $seconds;
    $stmt = db()->prepare(
        'INSERT INTO educator_auth_attempts (subject_hash, bucket)
         VALUES (:subject, :bucket)
         ON CONFLICT (subject_hash, bucket)
         DO UPDATE SET attempts = educator_auth_attempts.attempts + 1
         RETURNING attempts'
    );
    $stmt->execute([':subject' => hash('sha256', $scope), ':bucket' => $bucket]);
    $attempts = (int) $stmt->fetchColumn();
    if ($attempts > $limit) {
        header('Retry-After: ' . ($bucket + $seconds - $now));
        json_response(429, ['ok' => false, 'error' => 'Too many attempts. Please try again later.']);
    }
    if ($attempts === 1) {
        $cleanup = db()->prepare('DELETE FROM educator_auth_attempts WHERE bucket < :expired');
        $cleanup->execute([':expired' => $now - 86400]);
    }
}
