#!/usr/bin/env bash
set -euo pipefail

install -d -m 0755 /run/exam-scanner

export DB_DRIVER=pgsql EXAM_DISABLE_DEFAULT_EDUCATOR=1 EXAM_REQUIRE_EDUCATOR_SESSION=1
export DB_SSLROOTCERT="${DB_SSLROOTCERT:-/opt/exam-scanner/supabase-ca.crt}"
: "${DB_HOST:?Set the PostgreSQL host}"
: "${DB_PORT:?Set the PostgreSQL port}"
: "${DB_NAME:?Set the PostgreSQL database}"
: "${DB_USER:?Set the PostgreSQL role}"
: "${DB_PASS:?Set the PostgreSQL password}"

php -r 'require "/opt/exam-scanner/api/lib/db.php"; db()->query("SELECT educator_id FROM educator_sessions LIMIT 0");'
if [ "${EXAM_ONLINE_SCANNER:-}" = 1 ]; then
    php -r 'require "/opt/exam-scanner/api/lib/db.php"; db()->query("SELECT educator_id FROM online_scanners LIMIT 0"); db()->query("SELECT session_id, activity, feed_attempt FROM online_scan_jobs LIMIT 0");'
fi

printf 'OK\n' > /run/exam-scanner/health
test -s /var/www/html/exam-scanner/dist/index.html
exec apache2-foreground
