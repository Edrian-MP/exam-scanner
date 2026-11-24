<?php

declare(strict_types=1);

function app_config(): array
{
    static $config = null;
    if ($config !== null) {
        return $config;
    }

    $config = require __DIR__ . '/../config.php';
    return $config;
}

function db_is_postgres(): bool
{
    return app_config()['db_driver'] === 'pgsql';
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $cfg = app_config();
    $options = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ];
    if (db_is_postgres()) {
        $dsn = sprintf(
            'pgsql:host=%s;port=%d;dbname=%s;connect_timeout=%d;sslmode=%s;sslrootcert=%s',
            $cfg['db_host'],
            $cfg['db_port'],
            $cfg['db_name'],
            $cfg['db_timeout'],
            $cfg['db_sslmode'],
            str_replace('\\', '/', $cfg['db_sslrootcert'])
        );
    } else {
        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
            $cfg['db_host'],
            $cfg['db_port'],
            $cfg['db_name']
        );
        $options[PDO::ATTR_TIMEOUT] = $cfg['db_timeout'];
    }

    $connection = new PDO($dsn, $cfg['db_user'], $cfg['db_pass'], $options);
    if (db_is_postgres()) {
        $connection->exec('SET search_path TO exam_scanner, pg_catalog');
    }
    $pdo = $connection;

    return $pdo;
}

function db_insert_id(string $sql, array $parameters): int
{
    $connection = db();
    $postgres = db_is_postgres();
    $statement = $connection->prepare($postgres ? $sql . ' RETURNING id' : $sql);
    $statement->execute($parameters);

    return (int) ($postgres ? $statement->fetchColumn() : $connection->lastInsertId());
}
