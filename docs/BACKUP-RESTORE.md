# Grounded encrypted backup and restore runbook

This runbook provides a first version of an encrypted SQLite backup utility. It does not replace a managed backup service, off-host retention, monitoring, or a successful restore drill in the eventual production environment.

## Security requirements

- Run backups from a trusted host with access to the persistent SQLite volume.
- Store `BACKUP_ENCRYPTION_KEY` in the host's secret manager. It must be 32 random bytes represented as 64 hexadecimal characters.
- Keep the key separate from backup files and in a separately protected, access-controlled recovery location. Losing it makes backups unrecoverable.
- Store encrypted backups off-host in a private, access-controlled bucket or backup service with retention and deletion policies. Do not store the only backup on the same volume as the database.
- Limit access to backup keys and backup objects. Never log or commit keys, decrypted databases, or financial data.
- Backups can contain personal data and encrypted Plaid tokens. Treat them as sensitive financial records.

## Generate the encryption key

On a trusted machine, run:

    openssl rand -hex 32

Put the output into the server-side secret manager as `BACKUP_ENCRYPTION_KEY`. Do not paste it into chat or source control. Make and test a secure key-recovery copy before relying on backups.

## Create an encrypted backup

Set `DATABASE_PATH` to the active SQLite database path and `BACKUP_ENCRYPTION_KEY` in the trusted process environment. Optionally set `BACKUP_DIRECTORY` to a restricted local staging directory.

    npm run backup

The script uses SQLite's online backup API to produce a consistent temporary copy and encrypts it using AES-256-GCM. Output files use a `.sqlite.enc` suffix. Move/copy them to an off-host backup destination using the host's authenticated storage tooling. Verify that the destination object exists and has expected size before pruning older backups.

## Restore to a new file (non-destructive)

Stop application writes or restore into a separate recovery environment. Download one encrypted backup to a restricted directory and set:

- `BACKUP_FILE`: path to the encrypted backup.
- `RESTORE_DATABASE_PATH`: a new destination file path that does not already exist.
- `BACKUP_ENCRYPTION_KEY`: the matching key from the secret manager.
- `RESTORE_CONFIRM=YES`: explicit confirmation that the destination path is correct.

Then run:

    npm run restore

The restore script refuses to overwrite an existing destination, authenticates/decrypts the backup, and runs SQLite `integrity_check` before writing the restored file. If authentication fails or the file is truncated, the restore must fail. Do not point a live app at the recovered database until the next section is completed.

## Required restore drill before launch

- [ ] Back up a staging database containing only synthetic test data.
- [ ] Copy the encrypted backup to the intended off-host backup destination.
- [ ] Restore it to a fresh path using the documented key-recovery process.
- [ ] Confirm the restore command succeeds and SQLite integrity check returns `ok`.
- [ ] Start a staging API against the restored copy; test login, user isolation, dashboard, transaction reads, and bank disconnection using synthetic records only.
- [ ] Compare expected row counts and timestamps; confirm no real production user data was used in the drill.
- [ ] Record date, backup identifier, restore duration, result, operator, and corrective actions.
- [ ] Repeat after schema changes and on a schedule. Define the recovery point objective (maximum acceptable data loss) and recovery time objective (maximum acceptable outage) with the business owner.

## Important limitations

These scripts have not yet been run against Grounded's database in this environment. They are an implementation starting point, not proof of a completed backup/restore test. A host-specific scheduled backup, off-host upload, alerting, retention enforcement, and restore drill still need to be configured and verified. Do not declare backups production-ready until the CI tests and a staging restore drill pass.
