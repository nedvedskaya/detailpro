#!/usr/bin/env bash
# saas-crm: полный recovery point (PostgreSQL + var/) с проверкой и ротацией.
#
# Запуск: bash scripts/backup.sh
# Schedule: systemd unit saas-crm-backup.timer
#
# Как читать .env:
#   set -a    # автоэкспорт переменных
#   . .env
#   set +a
#
# Что делает:
#   1. pg_dump -Fc (custom format, бинарный, лучшее сжатие, можно --list)
#   2. Проверка целостности через pg_restore --list (молча должен выдать
#      оглавление; если не выдаст — дамп битый, exit 1)
#   3. Ротация: удаляем дампы старше $BACKUP_RETENTION_DAYS дней
#   4. В лог: размер последнего дампа + количество таблиц в нём
#
# Безопасность:
#   - PGPASSWORD передаётся через env переменную (не аргумент команды,
#     иначе он бы виделся в `ps aux`)
#   - Дамп в $BACKUP_DIR пишется с правами 0600 (chmod в конце)
#   - $DB_CA_CERT_PATH используется через PGSSLROOTCERT для managed-кластера
#
# Алертинг:
#   На этом этапе — только stderr и exit-code. Cron-обвязка пишет в
#   /var/log/saas-backup.log; хост-мониторинг (uptimerobot/Healthchecks.io)
#   проверяет, что lastrun.timestamp обновился. Когда поднимем SMTP/телегу,
#   добавим вызов notify_alert "$msg" внутри fail().

set -euo pipefail

# The database and persistent files form one logical recovery point.  The
# systemd unit stops application writes before invoking this script; refusing
# direct execution prevents a dump and a live file tree from drifting apart.
if [ "${BACKUP_WRITES_QUIESCED:-0}" != "1" ]; then
  echo "FAIL: backup requires BACKUP_WRITES_QUIESCED=1 from saas-crm-backup.service" >&2
  exit 1
fi

# ── 1. Чтение .env ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
cd "$PROJECT_ROOT"

if [ ! -f "$ENV_FILE" ]; then
  echo "[$(date -Iseconds)] FAIL: .env не найден в $PROJECT_ROOT" >&2
  exit 1
fi

# Раньше использовали `set -a; . "$ENV_FILE"; set +a` — но это интерпретирует
# .env как shell-script. Любое значение с cyrillic-символами и пробелами
# (например `LEGAL_OPERATOR_NAME=Ольга Иванова`) ломалось:
# `bash: Иванова: command not found` → set -e → exit.
#
# Берём только нужные ключи через grep — никакого shell-eval'а.
get_env_var() {
  # Извлекает значение KEY= из .env, обрезает inline-комментарий и
  # пробелы вокруг. Кавычки в значениях не поддерживаем (у нас их нет).
  #
  # Принципиально: если ключа нет — возвращаем "", не падаем. Скрипт
  # работает под `set -euo pipefail`, и пустой grep + pipefail иначе
  # роняет всю функцию.
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 || true)"
  if [ -z "$line" ]; then
    echo ""
    return 0
  fi
  printf '%s\n' "$line" \
    | cut -d= -f2- \
    | sed -E 's/[[:space:]]*#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//'
}

DB_HOST="$(get_env_var DB_HOST)"
DB_PORT="$(get_env_var DB_PORT)"
DB_USER="$(get_env_var DB_USER)"
DB_NAME="$(get_env_var DB_NAME)"
DB_PASSWORD="$(get_env_var DB_PASSWORD)"
DB_CA_CERT_PATH="$(get_env_var DB_CA_CERT_PATH)"
BACKUP_DIR="$(get_env_var BACKUP_DIR)"
BACKUP_RETENTION_DAYS="$(get_env_var BACKUP_RETENTION_DAYS)"
PERSISTENT_DATA_DIR_RAW="$(get_env_var PERSISTENT_DATA_DIR)"
PGSSLMODE_RAW="$(get_env_var PGSSLMODE)"

# ── 2. Валидация переменных ───────────────────────────────────────────
: "${DB_HOST:?DB_HOST не задан}"
: "${DB_PORT:=5432}"
: "${DB_USER:?DB_USER не задан}"
: "${DB_NAME:?DB_NAME не задан}"
: "${DB_PASSWORD:?DB_PASSWORD не задан}"
: "${BACKUP_DIR:?BACKUP_DIR не задан}"
: "${BACKUP_RETENTION_DAYS:=14}"

[[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] || { echo "FAIL: BACKUP_RETENTION_DAYS must be an integer" >&2; exit 1; }
if [ "$BACKUP_RETENTION_DAYS" -lt 1 ] || [ "$BACKUP_RETENTION_DAYS" -gt 365 ]; then
  echo "FAIL: BACKUP_RETENTION_DAYS must be between 1 and 365" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Один бэкап за раз: дублирующиеся cron/systemd-запуски не должны писать
# одновременно. Файл блокировки остаётся, сама advisory-lock снимается при exit.
exec 9>"$BACKUP_DIR/.backup.lock"
if ! flock -n 9; then
  echo "[$(date -Iseconds)] FAIL: другой backup уже выполняется" >&2
  exit 1
fi

# Логи помечаем меткой времени
TS="$(date +%Y%m%d-%H%M%S)-$$"
BACKUP_STARTED_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DUMP_FILE="$BACKUP_DIR/saas-${TS}.dump"
DUMP_PARTIAL="$DUMP_FILE.partial"
FILES_TGZ=""
FILES_PARTIAL=""
MANIFEST_FILE=""
MANIFEST_PARTIAL=""
BACKUP_COMPLETE=0
LOG_PREFIX="[$(date -Iseconds)]"

cleanup_partial() {
  rm -f "$DUMP_PARTIAL"
  rm -f "$DUMP_PARTIAL.toc"
  if [ -n "$FILES_PARTIAL" ]; then rm -f "$FILES_PARTIAL"; fi
  if [ -n "$MANIFEST_PARTIAL" ]; then rm -f "$MANIFEST_PARTIAL"; fi
  if [ "$BACKUP_COMPLETE" != "1" ]; then
    rm -f "$DUMP_FILE" "$DUMP_FILE.sha256"
    if [ -n "$FILES_TGZ" ]; then rm -f "$FILES_TGZ" "$FILES_TGZ.sha256"; fi
    if [ -n "$MANIFEST_FILE" ]; then rm -f "$MANIFEST_FILE"; fi
  fi
}
trap cleanup_partial EXIT

# ── 3. SSL/CA для managed-кластера ────────────────────────────────────
PGSSLMODE="${PGSSLMODE_RAW:-require}"
export PGSSLMODE
if [ -n "${DB_CA_CERT_PATH:-}" ] && [ -f "$DB_CA_CERT_PATH" ]; then
  export PGSSLROOTCERT="$DB_CA_CERT_PATH"
  PGSSLMODE="verify-full"
  export PGSSLMODE
fi

# pg_dump читает пароль из PGPASSWORD
export PGPASSWORD="$DB_PASSWORD"

fail() {
  echo "$LOG_PREFIX FAIL: $1" >&2
  exit 1
}

# Conservative capacity metadata is recorded from the source, not inferred
# from compressed archives.  Restore verification uses it before creating a
# second database or extracting files.
psql_scalar() {
  psql \
    --host="$DB_HOST" \
    --port="$DB_PORT" \
    --username="$DB_USER" \
    --dbname="$DB_NAME" \
    --no-align --tuples-only \
    --command="$1" | tr -d '[:space:]'
}

DB_SOURCE_BYTES="$(psql_scalar 'select pg_database_size(current_database());')"
[[ "$DB_SOURCE_BYTES" =~ ^[0-9]+$ ]] || fail "could not determine source database size"

STUDIOS_SOURCE_COUNT="$(psql_scalar 'select count(*) from saas_meta.studios;')"
TENANT_SCHEMA_OUTPUT="$(psql \
  --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" \
  --no-align --tuples-only \
  --command="select nspname from pg_namespace where nspname like 'studio\\_%' escape '\\' order by nspname;")"
CLIENTS_SOURCE_COUNT=0
RECORDS_SOURCE_COUNT=0
TASKS_SOURCE_COUNT=0
TENANT_SCHEMA_SOURCE_COUNT=0
while IFS= read -r tenant_schema; do
  [ -n "$tenant_schema" ] || continue
  [[ "$tenant_schema" =~ ^studio_[a-z0-9_]+$ ]] || fail "unsafe tenant schema name: $tenant_schema"
  tenant_clients="$(psql_scalar "select count(*) from \"$tenant_schema\".clients;")"
  tenant_records="$(psql_scalar "select count(*) from \"$tenant_schema\".client_records;")"
  tenant_tasks="$(psql_scalar "select count(*) from \"$tenant_schema\".tasks;")"
  for entity_count in "$tenant_clients" "$tenant_records" "$tenant_tasks"; do
    [[ "$entity_count" =~ ^[0-9]+$ ]] || fail "could not determine critical entity counts"
  done
  CLIENTS_SOURCE_COUNT=$((CLIENTS_SOURCE_COUNT + tenant_clients))
  RECORDS_SOURCE_COUNT=$((RECORDS_SOURCE_COUNT + tenant_records))
  TASKS_SOURCE_COUNT=$((TASKS_SOURCE_COUNT + tenant_tasks))
  TENANT_SCHEMA_SOURCE_COUNT=$((TENANT_SCHEMA_SOURCE_COUNT + 1))
done <<< "$TENANT_SCHEMA_OUTPUT"
for entity_count in "$STUDIOS_SOURCE_COUNT" "$TENANT_SCHEMA_SOURCE_COUNT" "$CLIENTS_SOURCE_COUNT" "$RECORDS_SOURCE_COUNT" "$TASKS_SOURCE_COUNT"; do
  [[ "$entity_count" =~ ^[0-9]+$ ]] || fail "invalid critical entity count"
done

PERSISTENT_DATA_DIR="${PERSISTENT_DATA_DIR_RAW:-$PROJECT_ROOT/var}"
[ -d "$PERSISTENT_DATA_DIR" ] || fail "каталог постоянных файлов не найден: $PERSISTENT_DATA_DIR"
if find "$PERSISTENT_DATA_DIR" -type l -print -quit | grep -q .; then
  fail "persistent data contains a symlink"
fi
if find "$PERSISTENT_DATA_DIR" ! -type d ! -type f -print -quit | grep -q .; then
  fail "persistent data contains an unsupported special file"
fi
FILES_SOURCE_COUNT="$(find "$PERSISTENT_DATA_DIR" -type f -printf '.' | wc -c | tr -d ' ')"
FILES_REGULAR_BYTES="$(find "$PERSISTENT_DATA_DIR" -type f -printf '%s\n' | awk '{sum += $1} END {print sum + 0}')"
[[ "$FILES_SOURCE_COUNT" =~ ^[0-9]+$ ]] || fail "could not determine persistent file count"
[[ "$FILES_REGULAR_BYTES" =~ ^[0-9]+$ ]] || fail "could not determine persistent file size"

# ── 4. pg_dump ────────────────────────────────────────────────────────
echo "$LOG_PREFIX pg_dump → $DUMP_PARTIAL"
if ! pg_dump \
      --host="$DB_HOST" \
      --port="$DB_PORT" \
      --username="$DB_USER" \
      --no-owner \
      --no-acl \
      --format=custom \
      --file="$DUMP_PARTIAL" \
      "$DB_NAME"; then
  fail "pg_dump exited non-zero"
fi

# ── 5. Integrity check ────────────────────────────────────────────────
# pg_restore --list читает заголовки и оглавление. Если дамп битый —
# вернёт ненулевой код. Stdout уводим в /dev/null, нам важен только exit-code
# и факт, что в оглавлении есть хотя бы одна таблица.
echo "$LOG_PREFIX pg_restore --list (integrity check)"
if ! pg_restore --list "$DUMP_PARTIAL" > "$DUMP_PARTIAL.toc" 2>/dev/null; then
  rm -f "$DUMP_PARTIAL.toc"
  fail "pg_restore --list failed: дамп битый"
fi

ENTRIES=$(wc -l < "$DUMP_PARTIAL.toc" | tr -d ' ')
rm -f "$DUMP_PARTIAL.toc"

if [ "$ENTRIES" -lt 5 ]; then
  fail "в дампе слишком мало записей: $ENTRIES — подозрение на пустую БД"
fi

chmod 600 "$DUMP_PARTIAL"
mv "$DUMP_PARTIAL" "$DUMP_FILE"
sha256sum "$DUMP_FILE" > "$DUMP_FILE.sha256"
chmod 600 "$DUMP_FILE.sha256"
SIZE=$(du -h "$DUMP_FILE" | awk '{print $1}')
echo "$LOG_PREFIX OK: размер $SIZE, записей в TOC $ENTRIES"

# ── 6. Все постоянные файлы CRM ───────────────────────────────────────
# В var/ находятся не только аватары, но и фотографии заказов, миниатюры
# и сформированные документы. Ошибка архивации делает recovery point
# неполным, поэтому такой запуск обязан завершиться ошибкой.
FILES_TGZ="$BACKUP_DIR/files-${TS}.tgz"
FILES_PARTIAL="$FILES_TGZ.partial"
echo "$LOG_PREFIX tar persistent data → $FILES_TGZ"
if ! tar -C "$(dirname "$PERSISTENT_DATA_DIR")" -czf "$FILES_PARTIAL" "$(basename "$PERSISTENT_DATA_DIR")"; then
  fail "tar persistent data failed"
fi
chmod 600 "$FILES_PARTIAL"
mv "$FILES_PARTIAL" "$FILES_TGZ"
sha256sum "$FILES_TGZ" > "$FILES_TGZ.sha256"
chmod 600 "$FILES_TGZ.sha256"
FILES_SIZE=$(du -h "$FILES_TGZ" | awk '{print $1}')
echo "$LOG_PREFIX OK persistent data: $FILES_SIZE"

# Off-site процесс использует только точки, для которых manifest был
# опубликован последним атомарным mv после успешной БД и всех файлов.
MANIFEST_FILE="$BACKUP_DIR/recovery-${TS}.manifest"
MANIFEST_PARTIAL="$MANIFEST_FILE.partial"
cat > "$MANIFEST_PARTIAL" <<EOF
format_version=2
backup_started_utc=$BACKUP_STARTED_UTC
backup_completed_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
database_file=$(basename "$DUMP_FILE")
database_sha256=$(sha256sum "$DUMP_FILE" | awk '{print $1}')
database_bytes=$(stat -c %s "$DUMP_FILE")
database_source_bytes=$DB_SOURCE_BYTES
database_toc_entries=$ENTRIES
studios_count=$STUDIOS_SOURCE_COUNT
tenant_schemas_count=$TENANT_SCHEMA_SOURCE_COUNT
clients_count=$CLIENTS_SOURCE_COUNT
client_records_count=$RECORDS_SOURCE_COUNT
tasks_count=$TASKS_SOURCE_COUNT
files_file=$(basename "$FILES_TGZ")
files_sha256=$(sha256sum "$FILES_TGZ" | awk '{print $1}')
files_bytes=$(stat -c %s "$FILES_TGZ")
files_uncompressed_bytes=$FILES_REGULAR_BYTES
files_count=$FILES_SOURCE_COUNT
EOF
chmod 600 "$MANIFEST_PARTIAL"
mv "$MANIFEST_PARTIAL" "$MANIFEST_FILE"
BACKUP_COMPLETE=1

# ── 7. Lastrun-маркер для внешнего мониторинга ────────────────────────
date -Iseconds > "$BACKUP_DIR/.lastrun.timestamp.$$"
mv "$BACKUP_DIR/.lastrun.timestamp.$$" "$BACKUP_DIR/lastrun.timestamp"

# ── 8. Ротация ────────────────────────────────────────────────────────
echo "$LOG_PREFIX ротация: старше ${BACKUP_RETENTION_DAYS} дней"
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'saas-*.dump' -o -name 'saas-*.dump.sha256' -o -name 'avatars-*.tgz' -o -name 'files-*.tgz' -o -name 'files-*.tgz.sha256' -o -name 'recovery-*.manifest' \) \
     -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete || true

echo "$LOG_PREFIX done"
