<?php

declare(strict_types=1);

return [
    'app_env' => getenv('APP_ENV') ?: 'dev',
    'require_educator_session' => getenv('EXAM_REQUIRE_EDUCATOR_SESSION') === '1',
    'online_scanner' => getenv('EXAM_ONLINE_SCANNER') === '1',
    'db_driver' => getenv('DB_DRIVER') ?: 'mysql',
    'db_host' => getenv('DB_HOST') ?: '127.0.0.1',
    'db_name' => getenv('DB_NAME') ?: 'exam_scanner',
    'db_user' => getenv('DB_USER') ?: 'root',
    'db_pass' => getenv('DB_PASS') ?: '',
    'db_port' => (int) (getenv('DB_PORT') ?: 3306),
    'db_timeout' => (int) (getenv('DB_TIMEOUT') ?: 3),
    'db_sslmode' => getenv('DB_SSLMODE') ?: 'verify-full',
    'db_sslrootcert' => getenv('DB_SSLROOTCERT') ?: '/etc/ssl/certs/ca-certificates.crt',
    'scanner_service_url' => getenv('SCANNER_SERVICE_URL') ?: 'http://127.0.0.1:5001',
    'cors_origin' => getenv('CORS_ORIGIN') ?: 'http://localhost:5173',
];
