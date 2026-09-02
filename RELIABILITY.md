# DetailPro CRM reliability and recovery

## What is protected

- PostgreSQL commits are durable (`fsync`, `synchronous_commit` and
  `full_page_writes` stay enabled).
- `saas-crm.service` restarts the Node process after a crash.
- `saas-crm-healthcheck.timer` detects a running but unhealthy app every minute
  and performs one bounded restart with a ten-minute cooldown.
- `saas-crm-backup.timer` creates a complete recovery point every hour:
  PostgreSQL custom dump, all persistent `var/` files, SHA-256 checksums and an
  atomic completion manifest. The app is briefly stopped while the snapshot is
  made so database rows and files belong to the same point in time; the unit
  always starts it again after success, failure or timeout.
- `saas-crm-backup-verify.timer` performs a real restore into an isolated
  temporary database every week and checks the file archive.
- `saas-crm-offsite-backup.timer` encrypts completed recovery points with an
  offline `age` recipient and pushes rolling hourly/daily/weekly copies to a
  dedicated private GitHub repository.
- `.github/workflows/reliability-monitor.yml` is a supplementary external
  readiness probe. A separate paging monitor is still required because
  scheduled GitHub workflows can be delayed.

## Security rules

1. Never upload a raw `.dump`, `.tgz`, `.env`, token or private key to GitHub.
2. Never point off-site backup at the public application repository.
3. The encryption private key stays on the recovery workstation and a second
   offline medium. The VPS receives only the public recipient.
4. The GitHub backup repository must remain private and use a dedicated deploy
   key. The script also fails closed if the repository becomes publicly visible.
5. GitHub is a secondary copy, not the only backup. Add versioned/Object-Lock
   object storage before claiming near-zero data-loss recovery.

## Recovery targets

- Current logical-backup RPO: at most about 75 minutes.
- Expected hourly backup interruption: normally a few seconds; the readiness
  watchdog recognizes this planned write quiesce and does not race it.
- Target after PostgreSQL WAL/PITR to immutable object storage: 5 minutes.
- Target RTO after a practiced clean-host recovery: 60 minutes.

## Required restore drill for the GitHub copy

On a clean trusted recovery host with the offline private key:

1. Clone the private backup repository and select a recovery point.
2. Verify `SHA256SUMS` for both encrypted artifacts.
3. Decrypt with `age -d -i <offline-private-key>`.
4. Verify plaintext hashes against `recovery.manifest`.
5. Restore the database into a new PostgreSQL instance with `pg_restore
   --exit-on-error`, extract `files.tgz` into the application data directory,
   and compare critical entity/file counts.
6. Record measured RTO and delete the temporary plaintext copy securely.

This drill must be performed after initial setup and at least monthly. Do not
place the private decryption key on the production VPS or in GitHub Actions.
