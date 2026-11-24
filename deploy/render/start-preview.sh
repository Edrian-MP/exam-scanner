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

data_dir=/var/lib/exam-scanner
socket=/run/mysqld/mysqld.sock
install -d -o mysql -g mysql "$data_dir" /run/mysqld

if [[ ! -d "$data_dir/mysql" ]]; then
    mariadb-install-db --user=mysql --datadir="$data_dir" --skip-test-db
fi

mariadbd --user=mysql --datadir="$data_dir" --socket="$socket" \
    --bind-address=127.0.0.1 --innodb-buffer-pool-size=48M &
database_pid=$!
apache_pid=

cleanup() {
    if [[ -n "$apache_pid" ]]; then
        kill -TERM "$apache_pid" 2>/dev/null || true
    fi
    kill -TERM "$database_pid" 2>/dev/null || true
    wait || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM

database_ready=false
for attempt in {1..45}; do
    if mariadb --protocol=socket --socket="$socket" --user=root -e 'SELECT 1' >/dev/null 2>&1; then
        database_ready=true
        break
    fi
    if ! kill -0 "$database_pid" 2>/dev/null; then
        break
    fi
    sleep 1
done
if [[ "$database_ready" != true ]]; then
    printf 'MariaDB failed to become ready.\n' >&2
    exit 1
fi

export DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=exam_scanner_app DB_NAME=exam_scanner
export EXAM_DISABLE_DEFAULT_EDUCATOR=1
export DB_PASS
DB_PASS=$(php -r 'echo bin2hex(random_bytes(24));')

mariadb --protocol=socket --socket="$socket" --user=root < /opt/exam-scanner/schema.sql
mariadb --protocol=socket --socket="$socket" --user=root <<SQL
CREATE USER IF NOT EXISTS 'exam_scanner_app'@'127.0.0.1';
ALTER USER 'exam_scanner_app'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
    ON exam_scanner.* TO 'exam_scanner_app'@'127.0.0.1';
SQL

printf 'OK\n' > /run/exam-scanner/health
test -s /var/www/html/exam-scanner/dist/index.html
apache2-foreground &
apache_pid=$!
wait -n "$apache_pid" "$database_pid"
