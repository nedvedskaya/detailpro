#!/usr/bin/env bash
# Local deadman checks for services, network, disk and backup freshness.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/saas-crm}"
MAX_BACKUP_AGE_SECONDS="${MAX_BACKUP_AGE_SECONDS:-5400}"
MAX_OFFSITE_AGE_SECONDS="${MAX_OFFSITE_AGE_SECONDS:-7200}"
MAX_RESTORE_VERIFY_AGE_SECONDS="${MAX_RESTORE_VERIFY_AGE_SECONDS:-691200}"
MAX_DISK_PERCENT="${MAX_DISK_PERCENT:-85}"
OFFSITE_MARKER="/var/lib/saas-crm-offsite/lastrun.timestamp"
RESTORE_MARKER="$BACKUP_DIR/restore-verified.timestamp"

failures=()

# Do not report planned backup downtime as an incident. Holding the same lock
# also makes backup wait for an audit that started just before maintenance.
exec 8>/run/saas-crm-maintenance.lock
if ! flock -n 8; then
  echo "OK: reliability audit skipped during coordinated maintenance"
  exit 0
fi

for unit in nginx.service postgresql@16-main.service saas-crm.service systemd-networkd.service; do
  systemctl is-active --quiet "$unit" || failures+=("inactive:$unit")
done

for timer in saas-crm-backup.timer saas-crm-backup-verify.timer saas-crm-healthcheck.timer saas-crm-reliability-audit.timer; do
  systemctl is-enabled --quiet "$timer" || failures+=("timer-disabled:$timer")
  systemctl is-active --quiet "$timer" || failures+=("timer-inactive:$timer")
done

ip -4 address show dev eth0 | grep -q 'inet ' || failures+=("eth0:no-ipv4")
ip -4 route show default | grep -q '^default ' || failures+=("network:no-default-route")

DISK_PERCENT="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
INODE_PERCENT="$(df --output=ipcent / | tail -1 | tr -dc '0-9')"
[ "$DISK_PERCENT" -le "$MAX_DISK_PERCENT" ] || failures+=("disk:${DISK_PERCENT}%")
[ "$INODE_PERCENT" -le "$MAX_DISK_PERCENT" ] || failures+=("inodes:${INODE_PERCENT}%")

LATEST_MANIFEST="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'recovery-*.manifest' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [ -z "$LATEST_MANIFEST" ]; then
  failures+=("backup:no-complete-manifest")
else
  BACKUP_AGE=$(( $(date +%s) - $(stat -c %Y "$LATEST_MANIFEST") ))
  [ "$BACKUP_AGE" -ge 0 ] && [ "$BACKUP_AGE" -le "$MAX_BACKUP_AGE_SECONDS" ] || failures+=("backup:stale-${BACKUP_AGE}s")
fi

if [ ! -r "$RESTORE_MARKER" ]; then
  failures+=("restore-verify:no-success-marker")
else
  RESTORE_AGE=$(( $(date +%s) - $(stat -c %Y "$RESTORE_MARKER") ))
  [ "$RESTORE_AGE" -ge 0 ] && [ "$RESTORE_AGE" -le "$MAX_RESTORE_VERIFY_AGE_SECONDS" ] || failures+=("restore-verify:stale-${RESTORE_AGE}s")
fi

if [ -e /etc/saas-crm/offsite-backup.env ]; then
  systemctl is-enabled --quiet saas-crm-offsite-backup.timer || failures+=("timer-disabled:saas-crm-offsite-backup.timer")
  systemctl is-active --quiet saas-crm-offsite-backup.timer || failures+=("timer-inactive:saas-crm-offsite-backup.timer")
  if [ ! -r "$OFFSITE_MARKER" ]; then
    failures+=("offsite:no-success-marker")
  else
    OFFSITE_AGE=$(( $(date +%s) - $(stat -c %Y "$OFFSITE_MARKER") ))
    [ "$OFFSITE_AGE" -ge 0 ] && [ "$OFFSITE_AGE" -le "$MAX_OFFSITE_AGE_SECONDS" ] || failures+=("offsite:stale-${OFFSITE_AGE}s")
  fi
fi

if [ "${#failures[@]}" -gt 0 ]; then
  printf 'FAIL: %s\n' "${failures[*]}" >&2
  exit 1
fi

echo "OK: services, network, disk and backup freshness"
