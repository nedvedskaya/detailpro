#!/usr/bin/env bash
# saas-crm: деплой на VPS через `git pull` + npm + systemctl restart.
#
# Запуск с локальной машины:
#   bash scripts/deploy.sh
#
# Что делает:
#   1. Локально: проверка main + working tree + sync с origin.
#   2. Удалённо: git fetch + git reset --hard origin/main (вместо rsync).
#      ВАЖНО: бот-кодер и Mac оба пушат в GitHub → GitHub = source of truth.
#      Сервер просто тянет последнюю версию main.
#   3. Удалённо: pre-deploy backup, npm ci, npm run init, build клиента,
#      systemctl restart saas-crm.
#   4. Health check через curl.
#
# Почему git pull вместо rsync:
#   • Раньше rsync с Mac затирал правки бота-кодера на сервере (бот
#     правил файлы напрямую, минуя git → терялись каждый раз).
#   • Теперь все правки идут через GitHub: и Mac, и бот пушат в main.
#   • Сервер хранит .git/, никаких расхождений с GitHub.
#
# Требования:
#   - На VPS: /var/www/saas-crm/ это git-репозиторий с remote origin →
#     git@github.com:nedvedskaya/detailpro.git, deploy key с write access.
#   - Пользователь deploy с NOPASSWD-доступом к `systemctl restart saas-crm`.
#   - На VPS лежит /var/www/saas-crm/.env (gitignored, не трогается).
#   - Node ≥22.
#
# Переменные окружения (можно положить в .env.deploy):
#   DEPLOY_HOST=83.217.200.79
#   DEPLOY_USER=deploy
#   DEPLOY_PATH=/var/www/saas-crm
#   DEPLOY_HEALTH_URL=https://detailprocrm.ru/api/ready

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
: "${DEPLOY_HEALTH_URL:=https://detailprocrm.ru/api/ready}"

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
TS="$(date -Iseconds)"

log() { echo "[$(date -Iseconds)] $*"; }
fail() { echo "[$(date -Iseconds)] FAIL: $*" >&2; exit 1; }

# ── 1.5 Pre-flight checks (локально) ───────────────────────────────────
# Защита от частых ошибок соло-разработки. Каждую можно обойти через
# DEPLOY_SKIP_CHECKS=1 (например для срочного хотфикса), но по умолчанию
# скрипт упрётся, если что-то не так.
if [ "${DEPLOY_SKIP_CHECKS:-0}" != "1" ]; then
  cd "$PROJECT_ROOT"

  # 1) Только из main. Деплой из feature-ветки = неконтролируемый эксперимент.
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$CURRENT_BRANCH" != "main" ]; then
    fail "деплой только из main, сейчас на '$CURRENT_BRANCH'."
  fi

  # 2) Working tree чистый.
  if [ -n "$(git status --porcelain)" ]; then
    git status --short
    fail "есть незакоммиченные изменения. Закоммить или stash, потом повтори."
  fi

  # 3) Локальная main не отстаёт от origin/main.
  git fetch --quiet origin main
  LOCAL="$(git rev-parse main)"
  REMOTE_SHA="$(git rev-parse origin/main)"
  BASE="$(git merge-base main origin/main)"
  if [ "$LOCAL" != "$REMOTE_SHA" ] && [ "$LOCAL" = "$BASE" ]; then
    fail "локальная main отстаёт от origin/main. Сделай git pull и повтори."
  fi

  # 4) Локальная main не должна опережать origin/main —
  #    сервер тянет с GitHub, а не с твоего Mac. Незапушенные коммиты
  #    не попадут на прод.
  if [ "$LOCAL" != "$REMOTE_SHA" ] && [ "$REMOTE_SHA" = "$BASE" ]; then
    fail "локальная main опережает origin/main. Сделай git push origin main и повтори."
  fi

  log "pre-flight ok: branch=main, tree clean, в синхроне с origin/main ($LOCAL)"
fi

# ── 1.6 Pre-deploy DB backup ───────────────────────────────────────────
# Recovery point ПЕРЕД pull — на случай, если новый код или миграция испортят
# данные. Та же systemd-служба кратко останавливает записи и сохраняет БД+var/.
if [ "${DEPLOY_SKIP_BACKUP:-0}" != "1" ]; then
  log "pre-deploy backup: systemctl start saas-crm-backup.service"
  if ! ssh -tt "${REMOTE}" "sudo -n /bin/systemctl start saas-crm-backup.service" 2>&1 | tail -10; then
    fail "pre-deploy backup упал. Деплой остановлен (или DEPLOY_SKIP_BACKUP=1 чтобы катить без бэкапа)."
  fi
fi

# ── 2. Удалённо: git pull + npm ci + build + init ──────────────────────
# Сервер сам тянет последнюю main с GitHub. Скрипт пишем в /tmp на сервере
# и выполняем — НЕ через heredoc-stdin, потому что npm ci/build читают
# stdin и съедают остаток скрипта (получаем exit 243 после server npm ci).
log "remote: git pull origin main + npm ci + build"

REMOTE_SCRIPT=$(cat <<'REMOTE_EOF'
#!/usr/bin/env bash
set -euo pipefail
cd __DEPLOY_PATH__

# Перед pull убедимся что нет случайных правок к ОТСЛЕЖИВАЕМЫМ файлам
# (например, кто-то редактировал файл напрямую вне git). Untracked файлы
# (-uno) пропускаем — reset --hard их не трогает, потерять нечего.
if [ -n "$(git status -uno --porcelain)" ]; then
  echo "FAIL: на сервере есть незакоммиченные изменения в отслеживаемых файлах:" >&2
  git status --short >&2
  echo "Залогинься и закоммить через 'git add -A && git commit && git push origin main', потом повтори деплой." >&2
  exit 1
fi

# Тянем main с GitHub. fetch + reset --hard вместо pull — чтобы избежать
# merge-конфликтов от случайных локальных коммитов (если они были).
git fetch --quiet origin main
git reset --hard origin/main

echo "[remote] HEAD: $(git log -1 --oneline)"

# Прод-зависимости сервера (без dev — не нужен tsc/eslint).
# </dev/null — чтобы npm не пытался читать stdin (иначе ssh-сессия рвётся).
npm ci --omit=dev </dev/null

# Сборка фронта прямо на сервере (раньше собирали локально и rsync'или
# client/dist; теперь dist в .gitignore не уезжает в GitHub).
cd __DEPLOY_PATH__/client
npm ci --silent </dev/null
npm run build </dev/null
cd __DEPLOY_PATH__

# Применяем глобальные миграции (000_*.sql, 018_*.sql и т.д.).
# Идемпотентно, IF NOT EXISTS / DROP IF EXISTS внутри.
npm run init </dev/null
REMOTE_EOF
)
# Подставляем DEPLOY_PATH в плейсхолдер.
REMOTE_SCRIPT="${REMOTE_SCRIPT//__DEPLOY_PATH__/${DEPLOY_PATH}}"

# Заливаем скрипт на сервер и выполняем.
echo "$REMOTE_SCRIPT" | ssh "${REMOTE}" "cat > /tmp/saas-deploy.sh && bash /tmp/saas-deploy.sh"

# ── 3. Restart ─────────────────────────────────────────────────────────
# Отдельной ssh-сессией с -tt (PTY): на VPS sudoers содержит Defaults use_pty,
# без TTY sudo откажет даже с NOPASSWD.
ssh -tt "${REMOTE}" "sudo -n /bin/systemctl restart saas-crm"
sleep 2
ssh "${REMOTE}" "systemctl is-active saas-crm" || echo "WARNING: saas-crm не active"

# ── 4. Health check ────────────────────────────────────────────────────
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
