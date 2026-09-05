#!/usr/bin/env bash
# Nightly Postgres dump for badminton-coach-helper. This is the only backup
# of financial data (payments, dues, credit ledger) other than a coach
# manually tapping "Export everything" in Settings — don't rely on that
# alone, it's a manual action a busy coach will forget to do.
#
# Install (you run this, not Claude — it edits your crontab):
#   crontab -e
#   # then add, e.g. nightly at 3am:
#   0 3 * * * /home/venky/Development-Personal/badminton-coach-helper/deploy/backup-db.sh >> /home/venky/badminton-coach-backups/backup.log 2>&1
#
# Restore from one of these dumps:
#   gunzip -c badminton_coach-<timestamp>.sql.gz | psql -h <host> -U <user> -d badminton_coach
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/server/.env"
BACKUP_DIR="${BACKUP_DIR:-$HOME/badminton-coach-backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-badminton_coach}"
DB_USER="${DB_USER:-postgres}"

if [[ -z "${DB_PASSWORD:-}" ]]; then
  echo "✗ DB_PASSWORD not found in $ENV_FILE — refusing to run." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="$BACKUP_DIR/${DB_NAME}-${TIMESTAMP}.sql.gz"

PGPASSWORD="$DB_PASSWORD" pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME" | gzip > "$OUT_FILE"
echo "✓ Backed up $DB_NAME to $OUT_FILE"

# Prune anything older than KEEP_DAYS so this doesn't grow forever.
find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz" -mtime "+${KEEP_DAYS}" -delete
