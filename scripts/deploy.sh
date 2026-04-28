#!/usr/bin/env bash
# saas-crm: деплой на VPS через rsync + npm + systemctl restart.
#
# Запуск с локальной машины:
#   bash scripts/deploy.sh
#
# Что делает:
#   1. Локально собирает фронт (vite build → client/dist).
#   2. rsync-ит репо на VPS, ИСКЛЮЧАЯ node_modules, .git, .env, ca.crt,
#      var/, *.log, *.dump.
#   3. На сервере: npm ci --omit=dev в server/, npm ci + build в client/
#      (если фронт не залит готовым), npm run init (идемпотентно),
#      systemctl restart saas-crm.
#   4. Проверка /api/health через curl.
#
# Требования:
#   - На VPS уже создан пользователь deploy с доступом sudo systemctl
#     restart saas-crm (через sudoers NOPASSWD).
#   - SSH-ключ deploy@VPS у вас в ~/.ssh/.
#   - На VPS лежит /var/www/saas-crm/.env  и /var/www/saas-crm/ca.crt.
#     Их деплой НЕ перезаписывает (rsync --exclude).
#   - На VPS установлен Node ≥22 (через nvm или nodesource).
#
# Переменные окружения для deploy.sh (можно положить в .env.deploy
# рядом со скриптом):
#   DEPLOY_HOST=83.217.200.79
#   DEPLOY_USER=deploy
#   DEPLOY_PATH=/var/www/saas-crm
#   DEPLOY_HEALTH_URL=https://detailprocrm.ru/api/health

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── 1. Конфиг ──────────────────────────────────────────────────────────
ENV_DEPLOY="$PROJECT_ROOT/.env.deploy"
if [ -f "$ENV_DEPLOY" ]; then
  set -a; . "$ENV_DEPLOY"; set +a
fi

: "${DEPLOY_HOST:?DEPLOY_HOST не задан (см. .env.deploy)}"
: "${DEPLOY_USER:=deploy}"
: "${DEPLOY_PATH:=/var/www/saas-crm}"
: "${DEPLOY_HEALTH_URL:=https://detailprocrm.ru/api/health}"

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
TS="$(date -Iseconds)"

log() { echo "[$(date -Iseconds)] $*"; }
fail() { echo "[$(date -Iseconds)] FAIL: $*" >&2; exit 1; }

# ── 1.5 Pre-flight checks ──────────────────────────────────────────────
# Защита от частых ошибок соло-разработки. Каждую можно обойти через
# DEPLOY_SKIP_CHECKS=1 (например для срочного хотфикса), но по умолчанию
# скрипт упрётся, если что-то не так.
if [ "${DEPLOY_SKIP_CHECKS:-0}" != "1" ]; then
  cd "$PROJECT_ROOT"

  # 1) Только из main. Деплой из feature-ветки = неконтролируемый эксперимент.
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$CURRENT_BRANCH" != "main" ]; then
    fail "деплой только из main, сейчас на '$CURRENT_BRANCH'. Слей в main и повтори (или DEPLOY_SKIP_CHECKS=1 для хотфикса)."
  fi

  # 2) Working tree чистый. Иначе rsync утянет на прод правки, которых нет в git.
  if [ -n "$(git status --porcelain)" ]; then
    git status --short
    fail "есть незакоммиченные изменения. Закоммить или stash, потом повтори."
  fi

  # 3) Локальная main не отстаёт от origin/main. Если отстаёт — мы катим старьё.
  git fetch --quiet origin main
  LOCAL="$(git rev-parse main)"
  REMOTE_SHA="$(git rev-parse origin/main)"
  BASE="$(git merge-base main origin/main)"
  if [ "$LOCAL" != "$REMOTE_SHA" ] && [ "$LOCAL" = "$BASE" ]; then
    fail "локальная main отстаёт от origin/main. Сделай git pull и повтори."
  fi

  log "pre-flight ok: branch=main, tree clean, in sync with origin"
fi

# ── 1.6 Pre-deploy DB backup ───────────────────────────────────────────
# Snapshot БД ПЕРЕД rsync — на случай, если новый код или миграция испортят
# данные. Daily-cron уже бэкапит, но между его запусками может пройти до 24ч.
# Запускаем backup.sh на сервере, потому что .env и pg_dump живут там.
if [ "${DEPLOY_SKIP_BACKUP:-0}" != "1" ]; then
  log "pre-deploy backup: ssh ${REMOTE} bash scripts/backup.sh"
  if ! ssh "${REMOTE}" "cd ${DEPLOY_PATH} && bash scripts/backup.sh" 2>&1 | tail -10; then
    fail "pre-deploy backup упал. Деплой остановлен (или DEPLOY_SKIP_BACKUP=1 чтобы катить без бэкапа)."
  fi
fi

# ── 2. Локальная сборка фронта ─────────────────────────────────────────
log "build: client (vite)"
cd "$PROJECT_ROOT/client"
npm ci --silent
npm run build
cd "$PROJECT_ROOT"

if [ ! -d "$PROJECT_ROOT/client/dist" ]; then
  echo "FAIL: client/dist не создалась" >&2
  exit 1
fi

# ── 3. rsync ───────────────────────────────────────────────────────────
log "rsync → ${REMOTE}:${DEPLOY_PATH}"
# --delete стираем мусор, но НЕ трогаем .env / ca.crt / var/ через --exclude.
# /node_modules исключаем — на сервере свой install.
rsync -az --delete \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude '.env.deploy' \
  --exclude 'ca.crt' \
  --exclude 'node_modules/' \
  --exclude 'client/node_modules/' \
  --exclude 'var/' \
  --exclude '*.log' \
  --exclude '*.dump' \
  --exclude '.DS_Store' \
  --exclude '.idea/' \
  --exclude '.vscode/' \
  "$PROJECT_ROOT/" "${REMOTE}:${DEPLOY_PATH}/"

# ── 4. Удалённая часть: install + init + restart ───────────────────────
log "remote: npm ci + init + restart"
ssh "${REMOTE}" bash -se <<EOF
set -euo pipefail
cd "${DEPLOY_PATH}"

# Прод-зависимости сервера (без dev — не нужен tsc/eslint)
npm ci --omit=dev

# Применяем 000_saas_meta.sql (идемпотентно, IF NOT EXISTS)
npm run init
EOF

# Рестарт делаем ОТДЕЛЬНОЙ ssh-сессией с -tt (PTY): на VPS sudoers содержит
# Defaults use_pty, поэтому без TTY sudo откажет даже с NOPASSWD. Отдельная
# сессия гарантирует, что PTY не конфликтует с heredoc-stdin предыдущей.
#
# ВАЖНО: НЕ делаем `</dev/null` после `-tt`. -tt запрашивает PTY на удалённой
# стороне, а перенаправление stdin от /dev/null отбирает его — sudo затем
# отказывает с "a password is required" (use_pty не выполнен). Раньше скрипт
# падал именно на этом и оставлял старый код на проде после rsync.
ssh -tt "${REMOTE}" "sudo -n /bin/systemctl restart saas-crm"
sleep 2
# Проверка состояния — БЕЗ sudo. Раньше тут было `sudo systemctl status`, но
# в /etc/sudoers.d/saas-crm у `deploy` разрешён ТОЛЬКО `restart saas-crm`,
# поэтому на status sudo возвращал "a password is required" — пугающая
# строка в логе деплоя при том, что рестарт по факту прошёл успешно.
# `systemctl is-active` работает от имени deploy без sudo.
ssh "${REMOTE}" "systemctl is-active saas-crm" || echo "WARNING: saas-crm не active"

# ── 5. Health check ────────────────────────────────────────────────────
log "health: ${DEPLOY_HEALTH_URL}"
sleep 3
HTTP=$(curl -sS -o /tmp/saas-health.json -w '%{http_code}' "${DEPLOY_HEALTH_URL}" || echo 000)
if [ "$HTTP" != "200" ]; then
  echo "FAIL: health check вернул HTTP $HTTP" >&2
  cat /tmp/saas-health.json >&2 || true
  exit 1
fi
log "OK: health = $(cat /tmp/saas-health.json)"
log "deploy done @ ${TS}"
