#!/usr/bin/env bash
# Minimal failure notifier. Secrets are read from .env and passed to curl via
# stdin config, so the bot token is not exposed in process arguments or logs.

set -euo pipefail

FAILED_UNIT="${1:-unknown.service}"
ENV_FILE="${CRM_ENV_FILE:-/var/www/saas-crm/.env}"
STATE_DIR="${ALERT_STATE_DIR:-/var/lib/saas-crm-alerts}"
COOLDOWN_SECONDS="${ALERT_COOLDOWN_SECONDS:-1800}"

[[ "$FAILED_UNIT" =~ ^[A-Za-z0-9@_.:-]+$ ]] || { echo "FAIL: invalid unit name" >&2; exit 1; }

get_env_var() {
  local key="$1" line
  line="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 || true)"
  [ -n "$line" ] || return 0
  printf '%s\n' "$line" | cut -d= -f2- | sed -E 's/[[:space:]]*#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//'
}

BOT_TOKEN="$(get_env_var TELEGRAM_BOT_TOKEN)"
CHAT_ID="$(get_env_var SUPPORT_TG_CHAT_ID)"
[ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ] || { echo "FAIL: Telegram alert destination is not configured" >&2; exit 1; }

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
MARKER="$STATE_DIR/${FAILED_UNIT}.last"
NOW_EPOCH="$(date +%s)"
LAST_EPOCH=0
[ -r "$MARKER" ] && read -r LAST_EPOCH < "$MARKER" || true
if [ $((NOW_EPOCH - LAST_EPOCH)) -lt "$COOLDOWN_SECONDS" ]; then
  echo "Alert suppressed by cooldown for $FAILED_UNIT"
  exit 0
fi

MESSAGE="DetailPro CRM: сбой ${FAILED_UNIT} на $(hostname) в $(date -u +%Y-%m-%dT%H:%M:%SZ). Проверьте systemctl status и journalctl."
curl --silent --show-error --fail --connect-timeout 5 --max-time 15 --config - >/dev/null <<EOF
url = "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage"
data-urlencode = "chat_id=${CHAT_ID}"
data-urlencode = "text=${MESSAGE}"
EOF

printf '%s\n' "$NOW_EPOCH" > "$MARKER.tmp"
mv "$MARKER.tmp" "$MARKER"
echo "Telegram alert delivered for $FAILED_UNIT"
