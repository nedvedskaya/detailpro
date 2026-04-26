#!/usr/bin/env bash
# saas-crm: ежедневный pg_dump с проверкой целостности и ротацией.
#
# Запуск: bash scripts/backup.sh
# Cron:   см. scripts/backup-cron.txt
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

# ── 1. Чтение .env ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "[$(date -Iseconds)] FAIL: .env не найден в $PROJECT_ROOT" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

# ── 2. Валидация переменных ───────────────────────────────────────────
: "${DB_HOST:?DB_HOST не задан}"
: "${DB_PORT:=5432}"
: "${DB_USER:?DB_USER не задан}"
: "${DB_NAME:?DB_NAME не задан}"
: "${DB_PASSWORD:?DB_PASSWORD не задан}"
: "${BACKUP_DIR:?BACKUP_DIR не задан}"
: "${BACKUP_RETENTION_DAYS:=14}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Логи помечаем меткой времени
TS="$(date +%Y%m%d-%H%M%S)"
DATE_TAG="$(date +%F)"
DUMP_FILE="$BACKUP_DIR/saas-${DATE_TAG}.dump"
LOG_PREFIX="[$(date -Iseconds)]"

# ── 3. SSL/CA для managed-кластера ────────────────────────────────────
PGSSLMODE="${PGSSLMODE:-require}"
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

# ── 4. pg_dump ────────────────────────────────────────────────────────
echo "$LOG_PREFIX pg_dump → $DUMP_FILE"
if ! pg_dump \
      --host="$DB_HOST" \
      --port="$DB_PORT" \
      --username="$DB_USER" \
      --no-owner \
      --no-acl \
      --format=custom \
      --file="$DUMP_FILE" \
      "$DB_NAME"; then
  fail "pg_dump exited non-zero"
fi

# ── 5. Integrity check ────────────────────────────────────────────────
# pg_restore --list читает заголовки и оглавление. Если дамп битый —
# вернёт ненулевой код. Stdout уводим в /dev/null, нам важен только exit-code
# и факт, что в оглавлении есть хотя бы одна таблица.
echo "$LOG_PREFIX pg_restore --list (integrity check)"
if ! pg_restore --list "$DUMP_FILE" > "$DUMP_FILE.toc" 2>/dev/null; then
  rm -f "$DUMP_FILE.toc"
  fail "pg_restore --list failed: дамп битый"
fi

ENTRIES=$(wc -l < "$DUMP_FILE.toc" | tr -d ' ')
rm -f "$DUMP_FILE.toc"

if [ "$ENTRIES" -lt 5 ]; then
  fail "в дампе слишком мало записей: $ENTRIES — подозрение на пустую БД"
fi

chmod 600 "$DUMP_FILE"
SIZE=$(du -h "$DUMP_FILE" | awk '{print $1}')
echo "$LOG_PREFIX OK: размер $SIZE, записей в TOC $ENTRIES"

# ── 6. Аватары пользователей ──────────────────────────────────────────
# Не пихаем в pg_dump (раздулся бы). tar отдельным файлом, ротация общая.
# AVATARS_DIR можно переопределить в .env, по умолчанию — стандартное место.
AVATARS_DIR="${AVATARS_DIR:-$PROJECT_ROOT/var/avatars}"
AVATARS_TGZ="$BACKUP_DIR/avatars-${DATE_TAG}.tgz"
if [ -d "$AVATARS_DIR" ]; then
  echo "$LOG_PREFIX tar avatars/ → $AVATARS_TGZ"
  if tar -C "$(dirname "$AVATARS_DIR")" -czf "$AVATARS_TGZ" "$(basename "$AVATARS_DIR")" 2>/dev/null; then
    chmod 600 "$AVATARS_TGZ"
    AVATARS_SIZE=$(du -h "$AVATARS_TGZ" | awk '{print $1}')
    echo "$LOG_PREFIX OK avatars: $AVATARS_SIZE"
  else
    echo "$LOG_PREFIX WARN: tar avatars failed (продолжаем — БД сохранена)" >&2
    rm -f "$AVATARS_TGZ"
  fi
else
  echo "$LOG_PREFIX skip avatars: $AVATARS_DIR не существует"
fi

# ── 7. Lastrun-маркер для внешнего мониторинга ────────────────────────
date -Iseconds > "$BACKUP_DIR/lastrun.timestamp"

# ── 8. Ротация ────────────────────────────────────────────────────────
echo "$LOG_PREFIX ротация: старше ${BACKUP_RETENTION_DAYS} дней"
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'saas-*.dump' -o -name 'avatars-*.tgz' \) \
     -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete || true

echo "$LOG_PREFIX done"
