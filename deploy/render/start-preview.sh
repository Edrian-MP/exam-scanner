#!/usr/bin/env bash
set -euo pipefail

password_file=/etc/secrets/preview-password
if [[ -r "$password_file" ]]; then
    RENDER_PREVIEW_PASSWORD=$(<"$password_file")
fi
if [[ -z "${RENDER_PREVIEW_PASSWORD:-}" ]] || [[ ${#RENDER_PREVIEW_PASSWORD} -lt 20 ]]; then
    printf 'Provide a preview password of at least 20 characters.\n' >&2
    exit 1
fi

install -d -m 0750 -o root -g www-data /run/exam-scanner
printf '%s\n' "$RENDER_PREVIEW_PASSWORD" | htpasswd -iBc /run/exam-scanner/users educator
chgrp www-data /run/exam-scanner/users
chmod 0640 /run/exam-scanner/users
unset RENDER_PREVIEW_PASSWORD

export DB_DRIVER=pgsql EXAM_DISABLE_DEFAULT_EDUCATOR=1
export DB_SSLROOTCERT="${DB_SSLROOTCERT:-/opt/exam-scanner/supabase-ca.crt}"
: "${DB_HOST:?Set the PostgreSQL host}"
: "${DB_PORT:?Set the PostgreSQL port}"
: "${DB_NAME:?Set the PostgreSQL database}"
: "${DB_USER:?Set the PostgreSQL role}"
: "${DB_PASS:?Set the PostgreSQL password}"

php -r 'require "/opt/exam-scanner/api/lib/db.php"; db()->query("SELECT id FROM educators LIMIT 0");'

printf 'OK\n' > /run/exam-scanner/health
test -s /var/www/html/exam-scanner/dist/index.html
exec apache2-foreground
