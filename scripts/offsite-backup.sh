#!/usr/bin/env bash
# Encrypt verified CRM backups and mirror rolling recovery points to a
# dedicated PRIVATE GitHub repository.  The age private key must never be
# present on the VPS or in GitHub; only its public recipient is installed.

set -euo pipefail

: "${OFFSITE_GIT_REPO:?OFFSITE_GIT_REPO is required}"
: "${OFFSITE_SSH_KEY:?OFFSITE_SSH_KEY is required}"
: "${AGE_RECIPIENTS_FILE:?AGE_RECIPIENTS_FILE is required}"
: "${OFFSITE_REPO_CONFIRMED_PRIVATE:?Set OFFSITE_REPO_CONFIRMED_PRIVATE=YES after verifying repository visibility}"

if [ "$OFFSITE_REPO_CONFIRMED_PRIVATE" != "YES" ]; then
  echo "FAIL: off-site repository was not explicitly confirmed private" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-/var/backups/saas-crm}"
STATE_DIR="${OFFSITE_STATE_DIR:-/var/lib/saas-crm-offsite}"
REPO_DIR="$STATE_DIR/repository"
BRANCH="${OFFSITE_GIT_BRANCH:-backup}"
KEEP_HOURLY="${OFFSITE_KEEP_HOURLY:-24}"
KEEP_DAILY="${OFFSITE_KEEP_DAILY:-30}"
KEEP_WEEKLY="${OFFSITE_KEEP_WEEKLY:-12}"

for numeric_value in "$KEEP_HOURLY" "$KEEP_DAILY" "$KEEP_WEEKLY"; do
  [[ "$numeric_value" =~ ^[0-9]+$ ]] && [ "$numeric_value" -ge 1 ] && [ "$numeric_value" -le 366 ] || {
    echo "FAIL: off-site retention values must be integers between 1 and 366" >&2
    exit 1
  }
done

for command_name in age curl git pg_restore sha256sum ssh timeout; do
  command -v "$command_name" >/dev/null || {
    echo "FAIL: required command is missing: $command_name" >&2
    exit 1
  }
done

[ -r "$AGE_RECIPIENTS_FILE" ] || { echo "FAIL: age recipients file is not readable" >&2; exit 1; }
[ -r "$OFFSITE_SSH_KEY" ] || { echo "FAIL: GitHub deploy key is not readable" >&2; exit 1; }

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
exec 9>"$STATE_DIR/.offsite-backup.lock"
flock -n 9 || { echo "FAIL: another off-site backup is already running" >&2; exit 1; }

LATEST_MANIFEST="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'recovery-*.manifest' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
[ -n "$LATEST_MANIFEST" ] && [ -r "$LATEST_MANIFEST" ] || { echo "FAIL: no completed recovery manifest found" >&2; exit 1; }

MAX_SOURCE_AGE_SECONDS="${OFFSITE_MAX_SOURCE_AGE_SECONDS:-3600}"
[[ "$MAX_SOURCE_AGE_SECONDS" =~ ^[0-9]+$ ]] && [ "$MAX_SOURCE_AGE_SECONDS" -ge 300 ] && [ "$MAX_SOURCE_AGE_SECONDS" -le 7200 ] || {
  echo "FAIL: OFFSITE_MAX_SOURCE_AGE_SECONDS must be between 300 and 7200" >&2
  exit 1
}

manifest_value() { sed -n "s/^$1=//p" "$LATEST_MANIFEST" | head -1; }
SOURCE_STARTED_UTC="$(manifest_value backup_started_utc)"
SOURCE_STARTED_EPOCH="$(date -u -d "$SOURCE_STARTED_UTC" +%s 2>/dev/null || true)"
[[ "$SOURCE_STARTED_EPOCH" =~ ^[0-9]+$ ]] || { echo "FAIL: invalid backup_started_utc in manifest" >&2; exit 1; }
MANIFEST_AGE_SECONDS=$(( $(date +%s) - SOURCE_STARTED_EPOCH ))
if [ "$MANIFEST_AGE_SECONDS" -lt 0 ] || [ "$MANIFEST_AGE_SECONDS" -gt "$MAX_SOURCE_AGE_SECONDS" ]; then
  echo "FAIL: newest completed recovery point is stale (${MANIFEST_AGE_SECONDS}s)" >&2
  exit 1
fi

DUMP_BASENAME="$(manifest_value database_file)"
FILES_BASENAME="$(manifest_value files_file)"
DUMP_SHA256="$(manifest_value database_sha256)"
FILES_SHA256="$(manifest_value files_sha256)"

[[ "$DUMP_BASENAME" =~ ^saas-[A-Za-z0-9._-]+\.dump$ ]] || { echo "FAIL: invalid database filename in manifest" >&2; exit 1; }
[[ "$FILES_BASENAME" =~ ^files-[A-Za-z0-9._-]+\.tgz$ ]] || { echo "FAIL: invalid files filename in manifest" >&2; exit 1; }
[[ "$DUMP_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "FAIL: invalid database checksum" >&2; exit 1; }
[[ "$FILES_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "FAIL: invalid files checksum" >&2; exit 1; }

LATEST_DUMP="$BACKUP_DIR/$DUMP_BASENAME"
LATEST_FILES="$BACKUP_DIR/$FILES_BASENAME"
[ -r "$LATEST_DUMP" ] && [ -r "$LATEST_FILES" ] || { echo "FAIL: completed recovery files are missing" >&2; exit 1; }
printf '%s  %s\n' "$DUMP_SHA256" "$LATEST_DUMP" | sha256sum -c - >/dev/null
printf '%s  %s\n' "$FILES_SHA256" "$LATEST_FILES" | sha256sum -c - >/dev/null
pg_restore --list "$LATEST_DUMP" >/dev/null

STAGE_DIR="$(mktemp -d "$STATE_DIR/.stage.XXXXXX")"
cleanup() {
  case "${STAGE_DIR:-}" in
    "$STATE_DIR"/.stage.*) rm -rf -- "$STAGE_DIR" ;;
  esac
}
trap cleanup EXIT

age -R "$AGE_RECIPIENTS_FILE" -o "$STAGE_DIR/database.dump.age" "$LATEST_DUMP"
age -R "$AGE_RECIPIENTS_FILE" -o "$STAGE_DIR/files.tgz.age" "$LATEST_FILES"
cp "$LATEST_MANIFEST" "$STAGE_DIR/recovery.manifest"

MAX_ARTIFACT_BYTES="${OFFSITE_MAX_ARTIFACT_BYTES:-90000000}"
[[ "$MAX_ARTIFACT_BYTES" =~ ^[0-9]+$ ]] && [ "$MAX_ARTIFACT_BYTES" -ge 1048576 ] && [ "$MAX_ARTIFACT_BYTES" -le 99000000 ] || {
  echo "FAIL: OFFSITE_MAX_ARTIFACT_BYTES must be between 1 MiB and 99 MB" >&2
  exit 1
}
for artifact in "$STAGE_DIR/database.dump.age" "$STAGE_DIR/files.tgz.age"; do
  if [ "$(stat -c %s "$artifact")" -gt "$MAX_ARTIFACT_BYTES" ]; then
    echo "FAIL: encrypted artifact exceeds GitHub-safe threshold: $(basename "$artifact")" >&2
    exit 1
  fi
done

case "$OFFSITE_GIT_REPO" in
  git@github.com:*.git) REPO_SLUG="${OFFSITE_GIT_REPO#git@github.com:}"; REPO_SLUG="${REPO_SLUG%.git}" ;;
  *) echo "FAIL: only an exact git@github.com:owner/repo.git target is allowed" >&2; exit 1 ;;
esac
VISIBILITY_BODY="$STAGE_DIR/github-visibility.json"
VISIBILITY_CODE="$(curl --silent --show-error --output "$VISIBILITY_BODY" --write-out '%{http_code}' --connect-timeout 5 --max-time 15 "https://api.github.com/repos/$REPO_SLUG")"
if [ "$VISIBILITY_CODE" = "200" ]; then
  echo "FAIL: refusing to upload CRM recovery data to a publicly visible GitHub repository" >&2
  exit 1
elif [ "$VISIBILITY_CODE" != "404" ]; then
  echo "FAIL: could not fail-closed verify private repository visibility (HTTP $VISIBILITY_CODE)" >&2
  exit 1
fi

export GIT_SSH_COMMAND="ssh -i $OFFSITE_SSH_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=2 -o ServerAliveInterval=15 -o ServerAliveCountMax=2"
if [ ! -d "$REPO_DIR/.git" ]; then
  timeout 5m git clone --no-checkout "$OFFSITE_GIT_REPO" "$REPO_DIR"
fi

git -C "$REPO_DIR" remote set-url origin "$OFFSITE_GIT_REPO"
timeout 5m git -C "$REPO_DIR" fetch --prune origin
if git -C "$REPO_DIR" show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  git -C "$REPO_DIR" checkout -f -B "$BRANCH" "origin/$BRANCH"
  git -C "$REPO_DIR" clean -ffd >/dev/null
else
  BOOTSTRAP_BRANCH="bootstrap-$$"
  git -C "$REPO_DIR" checkout --orphan "$BOOTSTRAP_BRANCH"
  git -C "$REPO_DIR" rm -rf --ignore-unmatch . >/dev/null 2>&1 || true
  git -C "$REPO_DIR" clean -ffd >/dev/null
  git -C "$REPO_DIR" branch -M "$BRANCH"
fi

NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HOURLY_KEY="$(date -u -d "@$SOURCE_STARTED_EPOCH" +%Y%m%d-%H)"
DAILY_KEY="$(date -u -d "@$SOURCE_STARTED_EPOCH" +%Y%m%d)"
WEEKLY_KEY="$(date -u -d "@$SOURCE_STARTED_EPOCH" +%G-W%V)"
HOURLY_DIR="$REPO_DIR/hourly/$HOURLY_KEY"
SOURCE_MANIFEST_SHA="$(sha256sum "$LATEST_MANIFEST" | awk '{print $1}')"

if [ -r "$HOURLY_DIR/recovery.manifest" ]; then
  EXISTING_MANIFEST_SHA="$(sha256sum "$HOURLY_DIR/recovery.manifest" | awk '{print $1}')"
  if [ "$EXISTING_MANIFEST_SHA" = "$SOURCE_MANIFEST_SHA" ]; then
    echo "OK: recovery point already uploaded; success marker intentionally unchanged"
    exit 0
  fi
fi

# A checkout is untrusted input. Reject symlinks before writing through any
# repository path; below we also reject every file outside the backup allowlist.
if find "$REPO_DIR" -path "$REPO_DIR/.git" -prune -o -type l -print -quit | grep -q .; then
  echo "FAIL: off-site repository contains a symlink" >&2
  exit 1
fi

mkdir -p "$HOURLY_DIR" "$REPO_DIR/daily" "$REPO_DIR/weekly" "$REPO_DIR/latest"
install -m 0600 "$STAGE_DIR/database.dump.age" "$HOURLY_DIR/database.dump.age"
install -m 0600 "$STAGE_DIR/files.tgz.age" "$HOURLY_DIR/files.tgz.age"
install -m 0600 "$STAGE_DIR/recovery.manifest" "$HOURLY_DIR/recovery.manifest"

rm -rf -- "$REPO_DIR/latest"
cp -a "$HOURLY_DIR" "$REPO_DIR/latest"
[ -d "$REPO_DIR/daily/$DAILY_KEY" ] || cp -a "$HOURLY_DIR" "$REPO_DIR/daily/$DAILY_KEY"
[ -d "$REPO_DIR/weekly/$WEEKLY_KEY" ] || cp -a "$HOURLY_DIR" "$REPO_DIR/weekly/$WEEKLY_KEY"

prune_snapshots() {
  local root="$1" keep="$2" index
  local -a snapshots=()
  [ -d "$root" ] || return 0
  mapfile -t snapshots < <(find "$root" -mindepth 1 -maxdepth 1 -type d -print | sort -r)
  for ((index=keep; index<${#snapshots[@]}; index++)); do
    case "${snapshots[$index]}" in
      "$root"/*) rm -rf -- "${snapshots[$index]}" ;;
      *) echo "FAIL: refusing to prune unexpected path" >&2; exit 1 ;;
    esac
  done
}

prune_snapshots "$REPO_DIR/hourly" "$KEEP_HOURLY"
prune_snapshots "$REPO_DIR/daily" "$KEEP_DAILY"
prune_snapshots "$REPO_DIR/weekly" "$KEEP_WEEKLY"

cat > "$REPO_DIR/RECOVERY.txt" <<EOF
Encrypted CRM recovery points. Repository visibility must remain PRIVATE.
Created UTC: $NOW_UTC
Source database archive: $DUMP_BASENAME
Source backup started UTC: $SOURCE_STARTED_UTC
Source manifest SHA-256: $SOURCE_MANIFEST_SHA
Encryption: age to recipients in the server-side public recipients file.
The decryption private key is not stored on the VPS or in this repository.
EOF

(cd "$REPO_DIR" && sha256sum latest/*.age > latest/SHA256SUMS)

validate_repository_allowlist() {
  local absolute relative
  while IFS= read -r -d '' absolute; do
    relative="${absolute#"$REPO_DIR"/}"
    if [ "$relative" = "RECOVERY.txt" ]; then
      continue
    fi
    if [[ "$relative" =~ ^latest/(database\.dump\.age|files\.tgz\.age|recovery\.manifest|SHA256SUMS)$ ]]; then
      continue
    fi
    if [[ "$relative" =~ ^hourly/[0-9]{8}-[0-9]{2}/(database\.dump\.age|files\.tgz\.age|recovery\.manifest)$ ]]; then
      continue
    fi
    if [[ "$relative" =~ ^daily/[0-9]{8}/(database\.dump\.age|files\.tgz\.age|recovery\.manifest)$ ]]; then
      continue
    fi
    if [[ "$relative" =~ ^weekly/[0-9]{4}-W[0-9]{2}/(database\.dump\.age|files\.tgz\.age|recovery\.manifest)$ ]]; then
      continue
    fi
    echo "FAIL: unexpected file in off-site repository: $relative" >&2
    return 1
  done < <(find "$REPO_DIR" -path "$REPO_DIR/.git" -prune -o -type f -print0)
}
validate_repository_allowlist

MAX_TREE_BYTES="${OFFSITE_MAX_TREE_BYTES:-800000000}"
[[ "$MAX_TREE_BYTES" =~ ^[0-9]+$ ]] && [ "$MAX_TREE_BYTES" -ge 1048576 ] && [ "$MAX_TREE_BYTES" -le 5000000000 ] || {
  echo "FAIL: OFFSITE_MAX_TREE_BYTES must be between 1 MiB and 5 GB" >&2
  exit 1
}
TREE_BYTES="$(du -sb "$REPO_DIR/hourly" "$REPO_DIR/daily" "$REPO_DIR/weekly" "$REPO_DIR/latest" | awk '{sum += $1} END {print sum}')"
if [ "$TREE_BYTES" -gt "$MAX_TREE_BYTES" ]; then
  echo "FAIL: GitHub recovery tree exceeds configured size ceiling ($TREE_BYTES bytes)" >&2
  exit 1
fi
git -C "$REPO_DIR" config user.name "DetailPro Backup"
git -C "$REPO_DIR" config user.email "backup@detailprocrm.ru"
# Build the index from an empty tree so a pre-existing gitlink, submodule or
# other index-only entry can never survive from the remote repository.
git -C "$REPO_DIR" read-tree --empty
git -C "$REPO_DIR" add -- RECOVERY.txt hourly daily weekly latest

TREE_SHA="$(git -C "$REPO_DIR" write-tree)"
ROOT_COMMIT="$(printf 'Encrypted CRM recovery points %s\n' "$NOW_UTC" | git -C "$REPO_DIR" commit-tree "$TREE_SHA")"
git -C "$REPO_DIR" reset --hard "$ROOT_COMMIT" >/dev/null
timeout 5m git -C "$REPO_DIR" push --force origin "$BRANCH:$BRANCH"
REMOTE_COMMIT="$(timeout 2m git -C "$REPO_DIR" ls-remote --heads origin "$BRANCH" | awk '{print $1}')"
[ "$REMOTE_COMMIT" = "$ROOT_COMMIT" ] || { echo "FAIL: remote GitHub commit verification failed" >&2; exit 1; }
git -C "$REPO_DIR" reflog expire --expire=now --all
git -C "$REPO_DIR" gc --prune=now

printf '%s\n' "$NOW_UTC" > "$STATE_DIR/lastrun.timestamp.tmp"
mv "$STATE_DIR/lastrun.timestamp.tmp" "$STATE_DIR/lastrun.timestamp"
echo "OK: encrypted off-site backup pushed at $NOW_UTC"
