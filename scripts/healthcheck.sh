#!/usr/bin/env bash
# Recover a running-but-unhealthy Node process without creating restart loops.

set -euo pipefail

READY_URL="${READY_URL:-http://127.0.0.1:3001/api/ready}"
COOLDOWN_SECONDS="${HEALTH_RESTART_COOLDOWN_SECONDS:-600}"
STATE_DIR="/run/saas-crm-healthcheck"
LAST_RESTART_FILE="$STATE_DIR/last-restart.epoch"

# The hourly backup briefly stops application writes so PostgreSQL and var/
# describe the same point in time.  This is planned maintenance, not an outage.
if [ -e /run/saas-crm-backup-quiesced ]; then
  exit 0
fi

mkdir -p "$STATE_DIR"

is_ready() {
  local body
  body="$(curl --silent --show-error --fail --connect-timeout 2 --max-time 5 "$READY_URL")" || return 1
  printf '%s' "$body" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' || return 1
  printf '%s' "$body" | grep -Eq '"database"[[:space:]]*:[[:space:]]*"ready"'
}

if is_ready; then
  exit 0
fi
sleep 3
if is_ready; then
  exit 0
fi
sleep 3
if is_ready; then
  exit 0
fi

# Serialize the final restart decision with quiesced backup. If backup owns the
# lock, planned downtime is in progress. If healthcheck wins first, backup waits
# until this bounded restart attempt has completed before it stops the app.
exec 8>/run/saas-crm-maintenance.lock
if ! flock -n 8; then
  exit 0
fi
if [ -e /run/saas-crm-backup-quiesced ]; then
  exit 0
fi

NOW="$(date +%s)"
LAST_RESTART=0
[ -r "$LAST_RESTART_FILE" ] && read -r LAST_RESTART < "$LAST_RESTART_FILE" || true
if [ $((NOW - LAST_RESTART)) -lt "$COOLDOWN_SECONDS" ]; then
  echo "FAIL: CRM is unhealthy; restart suppressed by cooldown" >&2
  exit 1
fi

printf '%s\n' "$NOW" > "$LAST_RESTART_FILE.tmp"
mv "$LAST_RESTART_FILE.tmp" "$LAST_RESTART_FILE"
systemctl restart saas-crm.service
sleep 5
if ! is_ready; then
  echo "FAIL: CRM remained unhealthy after restart" >&2
  exit 1
fi
echo "RECOVERED: CRM became ready after automatic restart"
