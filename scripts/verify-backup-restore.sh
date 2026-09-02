#!/usr/bin/env bash
# Perform a real restore into an isolated temporary database, then remove it.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/saas-crm}"
SOURCE_DB="${DB_NAME:-saas_crm}"
VERIFY_DB="${VERIFY_DB_NAME:-saas_crm_restore_verify}"
LOCK_FILE="$BACKUP_DIR/.restore-verify.lock"

case "$VERIFY_DB" in
  saas_crm_restore_verify|saas_crm_restore_verify_*) ;;
  *) echo "FAIL: VERIFY_DB_NAME must use the saas_crm_restore_verify prefix" >&2; exit 1 ;;
esac
if [ "$VERIFY_DB" = "$SOURCE_DB" ]; then
  echo "FAIL: verification database must never equal the production database" >&2
  exit 1
fi

exec 9>"$LOCK_FILE"
flock -n 9 || { echo "FAIL: another restore verification is running" >&2; exit 1; }

LATEST_MANIFEST="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'recovery-*.manifest' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
[ -n "$LATEST_MANIFEST" ] && [ -r "$LATEST_MANIFEST" ] || { echo "FAIL: no completed recovery manifest found" >&2; exit 1; }

manifest_value() { sed -n "s/^$1=//p" "$LATEST_MANIFEST" | head -1; }
DUMP_BASENAME="$(manifest_value database_file)"
FILES_BASENAME="$(manifest_value files_file)"
DUMP_SHA256="$(manifest_value database_sha256)"
FILES_SHA256="$(manifest_value files_sha256)"
DB_SOURCE_BYTES="$(manifest_value database_source_bytes)"
FILES_SOURCE_BYTES="$(manifest_value files_uncompressed_bytes)"
EXPECTED_FILES_COUNT="$(manifest_value files_count)"
DUMP_ARCHIVE_BYTES="$(manifest_value database_bytes)"
FILES_ARCHIVE_BYTES="$(manifest_value files_bytes)"
EXPECTED_STUDIOS="$(manifest_value studios_count)"
EXPECTED_TENANT_SCHEMAS="$(manifest_value tenant_schemas_count)"
EXPECTED_CLIENTS="$(manifest_value clients_count)"
EXPECTED_RECORDS="$(manifest_value client_records_count)"
EXPECTED_TASKS="$(manifest_value tasks_count)"
[[ "$DUMP_BASENAME" =~ ^saas-[A-Za-z0-9._-]+\.dump$ ]] || { echo "FAIL: invalid database filename in manifest" >&2; exit 1; }
[[ "$FILES_BASENAME" =~ ^files-[A-Za-z0-9._-]+\.tgz$ ]] || { echo "FAIL: invalid files filename in manifest" >&2; exit 1; }
[[ "$DUMP_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "FAIL: invalid database checksum" >&2; exit 1; }
[[ "$FILES_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "FAIL: invalid files checksum" >&2; exit 1; }
[[ "$DB_SOURCE_BYTES" =~ ^[0-9]+$ ]] || { echo "FAIL: invalid source database size" >&2; exit 1; }
[[ "$FILES_SOURCE_BYTES" =~ ^[0-9]+$ ]] || { echo "FAIL: invalid uncompressed files size" >&2; exit 1; }
[[ "$EXPECTED_FILES_COUNT" =~ ^[0-9]+$ ]] || { echo "FAIL: invalid persistent file count" >&2; exit 1; }
[[ "$DUMP_ARCHIVE_BYTES" =~ ^[0-9]+$ ]] || { echo "FAIL: invalid database archive size" >&2; exit 1; }
[[ "$FILES_ARCHIVE_BYTES" =~ ^[0-9]+$ ]] || { echo "FAIL: invalid files archive size" >&2; exit 1; }
for expected_count in "$EXPECTED_STUDIOS" "$EXPECTED_TENANT_SCHEMAS" "$EXPECTED_CLIENTS" "$EXPECTED_RECORDS" "$EXPECTED_TASKS"; do
  [[ "$expected_count" =~ ^[0-9]+$ ]] || { echo "FAIL: invalid critical entity count in manifest" >&2; exit 1; }
done

LATEST_DUMP="$BACKUP_DIR/$DUMP_BASENAME"
LATEST_FILES="$BACKUP_DIR/$FILES_BASENAME"
[ -r "$LATEST_DUMP" ] && [ -r "$LATEST_FILES" ] || { echo "FAIL: completed recovery files are missing" >&2; exit 1; }
printf '%s  %s\n' "$DUMP_SHA256" "$LATEST_DUMP" | sha256sum -c - >/dev/null
printf '%s  %s\n' "$FILES_SHA256" "$LATEST_FILES" | sha256sum -c - >/dev/null
pg_restore --list "$LATEST_DUMP" >/dev/null
tar -tzf "$LATEST_FILES" >/dev/null

POSTGRES_DEVICE="$(stat -c %d /var/lib/postgresql)"
STAGE_DEVICE="$(stat -c %d /var/tmp)"
POSTGRES_AVAILABLE_BYTES="$(df --output=avail -B1 /var/lib/postgresql | tail -1 | tr -d ' ')"
STAGE_AVAILABLE_BYTES="$(df --output=avail -B1 /var/tmp | tail -1 | tr -d ' ')"
# Account for restored data, PostgreSQL working/WAL space, archive copies and
# extracted files. Compressed size alone is unsafe because it can expand by
# tens of times. Check both filesystems if PostgreSQL and staging differ.
if [ "$POSTGRES_DEVICE" = "$STAGE_DEVICE" ]; then
  MIN_FREE_BYTES=$(( DB_SOURCE_BYTES * 2 + FILES_SOURCE_BYTES * 2 + DUMP_ARCHIVE_BYTES + FILES_ARCHIVE_BYTES + 2147483648 ))
  [ "$POSTGRES_AVAILABLE_BYTES" -ge "$MIN_FREE_BYTES" ] || { echo "FAIL: insufficient shared disk space for safe restore verification" >&2; exit 1; }
else
  MIN_POSTGRES_FREE_BYTES=$(( DB_SOURCE_BYTES * 2 + 1073741824 ))
  MIN_STAGE_FREE_BYTES=$(( FILES_SOURCE_BYTES * 2 + DUMP_ARCHIVE_BYTES + FILES_ARCHIVE_BYTES + 1073741824 ))
  [ "$POSTGRES_AVAILABLE_BYTES" -ge "$MIN_POSTGRES_FREE_BYTES" ] || { echo "FAIL: insufficient PostgreSQL disk space for safe restore verification" >&2; exit 1; }
  [ "$STAGE_AVAILABLE_BYTES" -ge "$MIN_STAGE_FREE_BYTES" ] || { echo "FAIL: insufficient staging disk space for safe restore verification" >&2; exit 1; }
fi

STAGE_DIR="$(mktemp -d /var/tmp/saas-restore-verify.XXXXXX)"
cleanup() {
  runuser -u postgres -- dropdb --if-exists --force "$VERIFY_DB" >/dev/null 2>&1 || true
  case "${STAGE_DIR:-}" in
    /var/tmp/saas-restore-verify.*) rm -rf -- "$STAGE_DIR" ;;
  esac
}
trap cleanup EXIT

chown root:root "$STAGE_DIR"
chmod 0711 "$STAGE_DIR"
install -o postgres -g postgres -m 0600 "$LATEST_DUMP" "$STAGE_DIR/database.dump"
install -o nobody -g nogroup -m 0600 "$LATEST_FILES" "$STAGE_DIR/files.tgz"

runuser -u postgres -- dropdb --if-exists --force "$VERIFY_DB"
runuser -u postgres -- createdb --template=template0 "$VERIFY_DB"
runuser -u postgres -- pg_restore --no-owner --no-acl --exit-on-error --dbname="$VERIFY_DB" "$STAGE_DIR/database.dump"

mkdir "$STAGE_DIR/files"
chown nobody:nogroup "$STAGE_DIR/files"
chmod 0700 "$STAGE_DIR/files"
runuser -u nobody -- tar -xzf "$STAGE_DIR/files.tgz" -C "$STAGE_DIR/files" --no-same-owner --no-same-permissions
[ -d "$STAGE_DIR/files/var/avatars" ] || { echo "FAIL: restored files have no avatars directory" >&2; exit 1; }
[ -d "$STAGE_DIR/files/var/documents" ] || { echo "FAIL: restored files have no documents directory" >&2; exit 1; }

RESTORED_FILES_COUNT="$(find "$STAGE_DIR/files/var" -type f -printf '.' | wc -c | tr -d ' ')"
RESTORED_FILES_BYTES="$(find "$STAGE_DIR/files/var" -type f -printf '%s\n' | awk '{sum += $1} END {print sum + 0}')"
if [ "$RESTORED_FILES_COUNT" -ne "$EXPECTED_FILES_COUNT" ] || [ "$RESTORED_FILES_BYTES" -ne "$FILES_SOURCE_BYTES" ]; then
  echo "FAIL: extracted file inventory differs from manifest (count=$RESTORED_FILES_COUNT/$EXPECTED_FILES_COUNT bytes=$RESTORED_FILES_BYTES/$FILES_SOURCE_BYTES)" >&2
  exit 1
fi

TABLE_COUNT="$(runuser -u postgres -- psql -d "$VERIFY_DB" -Atc "select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema');")"
STUDIO_TABLE="$(runuser -u postgres -- psql -d "$VERIFY_DB" -Atc "select to_regclass('saas_meta.studios') is not null;")"
if [ "$TABLE_COUNT" -lt 10 ] || [ "$STUDIO_TABLE" != "t" ]; then
  echo "FAIL: restored database failed structural checks (tables=$TABLE_COUNT, studios=$STUDIO_TABLE)" >&2
  exit 1
fi

RESTORED_SCHEMA_COUNT="$(runuser -u postgres -- psql -d "$VERIFY_DB" -Atc "select count(*) from pg_namespace where nspname like 'studio_%';")"
if [ "$RESTORED_SCHEMA_COUNT" -lt 1 ]; then
  echo "FAIL: restored database contains no tenant schemas" >&2
  exit 1
fi

RESTORED_STUDIOS="$(runuser -u postgres -- psql -d "$VERIFY_DB" -Atc "select count(*) from saas_meta.studios;")"
RESTORED_CLIENTS=0
RESTORED_RECORDS=0
RESTORED_TASKS=0

# A database-only restore can look healthy while user-uploaded files are
# missing.  Reconcile every stored avatar and order-photo reference against the
# extracted archive, rejecting unexpected paths before touching the filesystem.
MISSING_FILES=0
AVATAR_REFS_FILE="$STAGE_DIR/avatar-refs.txt"
if ! runuser -u postgres -- psql -d "$VERIFY_DB" -Atc \
  "select avatar_path from saas_meta.users where avatar_path is not null and avatar_path <> '' order by avatar_path;" > "$AVATAR_REFS_FILE"; then
  echo "FAIL: could not read avatar references from restored database" >&2
  exit 1
fi
while IFS= read -r avatar_path; do
  [ -n "$avatar_path" ] || continue
  if [[ ! "$avatar_path" =~ ^/avatars/[A-Za-z0-9._-]+$ ]]; then
    echo "FAIL: unsafe avatar path in restored database: $avatar_path" >&2
    exit 1
  fi
  if [ ! -f "$STAGE_DIR/files/var$avatar_path" ]; then
    echo "FAIL: restored avatar is missing: $avatar_path" >&2
    MISSING_FILES=$((MISSING_FILES + 1))
  fi
done < "$AVATAR_REFS_FILE"

TENANT_SCHEMAS_FILE="$STAGE_DIR/tenant-schemas.txt"
if ! runuser -u postgres -- psql -d "$VERIFY_DB" -Atc \
  "select nspname from pg_namespace where nspname like 'studio\\_%' escape '\\' order by nspname;" > "$TENANT_SCHEMAS_FILE"; then
  echo "FAIL: could not read tenant schemas from restored database" >&2
  exit 1
fi
while IFS= read -r tenant_schema; do
  [[ "$tenant_schema" =~ ^studio_[a-z0-9_]+$ ]] || {
    echo "FAIL: unsafe tenant schema name in restored database: $tenant_schema" >&2
    exit 1
  }
  tenant_clients="$(runuser -u postgres -- psql -d "$VERIFY_DB" -Atc "select count(*) from \"$tenant_schema\".clients;")"
  tenant_records="$(runuser -u postgres -- psql -d "$VERIFY_DB" -Atc "select count(*) from \"$tenant_schema\".client_records;")"
  tenant_tasks="$(runuser -u postgres -- psql -d "$VERIFY_DB" -Atc "select count(*) from \"$tenant_schema\".tasks;")"
  RESTORED_CLIENTS=$((RESTORED_CLIENTS + tenant_clients))
  RESTORED_RECORDS=$((RESTORED_RECORDS + tenant_records))
  RESTORED_TASKS=$((RESTORED_TASKS + tenant_tasks))
  PHOTO_REFS_FILE="$STAGE_DIR/photo-refs.$tenant_schema.txt"
  if ! runuser -u postgres -- psql -d "$VERIFY_DB" -Atc \
    "select path from (select file_path as path from \"$tenant_schema\".order_photos union all select thumbnail_path from \"$tenant_schema\".order_photos) refs where path is not null order by path;" > "$PHOTO_REFS_FILE"; then
    echo "FAIL: could not read document references from restored schema: $tenant_schema" >&2
    exit 1
  fi
  while IFS= read -r relative_path; do
    [ -n "$relative_path" ] || continue
    if [[ ! "$relative_path" =~ ^(photos|thumbs)/[A-Za-z0-9._-]+$ ]]; then
      echo "FAIL: unsafe document path in restored database: $tenant_schema/$relative_path" >&2
      exit 1
    fi
    if [ ! -f "$STAGE_DIR/files/var/documents/$tenant_schema/$relative_path" ]; then
      echo "FAIL: restored document is missing: $tenant_schema/$relative_path" >&2
      MISSING_FILES=$((MISSING_FILES + 1))
    fi
  done < "$PHOTO_REFS_FILE"
done < "$TENANT_SCHEMAS_FILE"

if [ "$RESTORED_STUDIOS" -ne "$EXPECTED_STUDIOS" ] \
  || [ "$RESTORED_SCHEMA_COUNT" -ne "$EXPECTED_TENANT_SCHEMAS" ] \
  || [ "$RESTORED_CLIENTS" -ne "$EXPECTED_CLIENTS" ] \
  || [ "$RESTORED_RECORDS" -ne "$EXPECTED_RECORDS" ] \
  || [ "$RESTORED_TASKS" -ne "$EXPECTED_TASKS" ]; then
  echo "FAIL: restored critical counts differ from manifest (studios=$RESTORED_STUDIOS/$EXPECTED_STUDIOS schemas=$RESTORED_SCHEMA_COUNT/$EXPECTED_TENANT_SCHEMAS clients=$RESTORED_CLIENTS/$EXPECTED_CLIENTS records=$RESTORED_RECORDS/$EXPECTED_RECORDS tasks=$RESTORED_TASKS/$EXPECTED_TASKS)" >&2
  exit 1
fi

if [ "$MISSING_FILES" -ne 0 ]; then
  echo "FAIL: restored database references $MISSING_FILES missing persistent file(s)" >&2
  exit 1
fi

date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/restore-verified.timestamp.tmp"
mv "$BACKUP_DIR/restore-verified.timestamp.tmp" "$BACKUP_DIR/restore-verified.timestamp"
echo "OK: restored $(basename "$LATEST_DUMP") into temporary DB; tables=$TABLE_COUNT tenant_schemas=$RESTORED_SCHEMA_COUNT clients=$RESTORED_CLIENTS records=$RESTORED_RECORDS tasks=$RESTORED_TASKS files_reconciled=true"
