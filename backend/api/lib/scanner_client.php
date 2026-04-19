<?php

declare(strict_types=1);

function scanner_request(string $path, string $method = 'GET', ?array $payload = null): array
{
    $cfg = app_config();
    $url = rtrim($cfg['scanner_service_url'], '/') . '/' . ltrim($path, '/');

    $headers = [
        'Accept: application/json',
        'Content-Type: application/json',
    ];

    $method = strtoupper($method);
    $body = $payload ? json_encode($payload) : null;

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 2);
        curl_setopt($ch, CURLOPT_TIMEOUT, 12);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $response = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
    } else {
        $context = stream_context_create([
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", $headers),
                'content' => $body ?? '',
                'timeout' => 12,
            ],
        ]);
        $response = @file_get_contents($url, false, $context);
        $code = 200;
    }

    if (!is_string($response) || $response === '') {
        return ['ok' => false, 'error' => 'Scanner service unreachable'];
    }

    $decoded = json_decode($response, true);
    if (!is_array($decoded)) {
        return ['ok' => false, 'error' => 'Invalid scanner response'];
    }

    if ($code >= 400) {
        return ['ok' => false, 'error' => $decoded['error'] ?? 'Scanner service error'];
    }

    return $decoded;
}
