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

# Рестарт через systemd (sudoers NOPASSWD)
sudo systemctl restart saas-crm

# Лог последних 20 строк юнита для быстрой диагностики
sleep 2
sudo systemctl status saas-crm --no-pager --lines=20 || true
EOF

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
