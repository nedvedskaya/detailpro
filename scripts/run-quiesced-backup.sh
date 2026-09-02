#!/usr/bin/env bash
# Coordinate the write quiesce with the readiness watchdog and always restore
# application availability. systemd ExecStopPost is an additional kill/timeout
# fallback around this script.

set -euo pipefail

LOCK_FILE=/run/saas-crm-maintenance.lock
MARKER_FILE=/run/saas-crm-backup-quiesced
BACKUP_SCRIPT="${BACKUP_SCRIPT:-/var/www/saas-crm/scripts/backup.sh}"
[ -r "$BACKUP_SCRIPT" ] || { echo "FAIL: backup script is not readable: $BACKUP_SCRIPT" >&2; exit 1; }

exec 8>"$LOCK_FILE"
flock -x 8

cleanup() {
  systemctl start saas-crm.service >/dev/null 2>&1 || true
  rm -f "$MARKER_FILE"
}
trap cleanup EXIT

touch "$MARKER_FILE"
systemctl stop saas-crm.service
runuser -u deploy -- env BACKUP_WRITES_QUIESCED=1 \
  /bin/bash "$BACKUP_SCRIPT"
