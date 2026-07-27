#!/usr/bin/env bash
# Nightly pg_dump backup for Pauken.
# Place in /etc/cron.daily/pauken-backup or run as a systemd timer.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/pauken}"
DB_URL="${DATABASE_URL:-postgres://pauken:pauken@localhost:5432/pauken}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
FILENAME="pauken-${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "==> Backing up Pauken database..."
pg_dump "$DB_URL" | gzip > "${BACKUP_DIR}/${FILENAME}"

echo "==> Removing backups older than ${RETENTION_DAYS} days..."
find "$BACKUP_DIR" -name "pauken-*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete

echo "==> Backup saved: ${BACKUP_DIR}/${FILENAME}"
