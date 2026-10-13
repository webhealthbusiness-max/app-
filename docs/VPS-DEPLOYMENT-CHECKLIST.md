# Grounded VPS deployment checklist

Status: preparation only. Grounded is not deployed. The current release PR remains open and must not be merged without the owner's explicit approval. Do not put secret values in GitHub files, issues, pull requests, chat, or terminal command arguments.

## Target architecture

- One Ubuntu LTS VPS, Docker Engine + Compose, one Grounded application container, and Caddy as the HTTPS reverse proxy.
- Grounded listens inside the container on port 4000. Publish it only to loopback (127.0.0.1), not directly to the public internet.
- Persist SQLite at /data/grounded.db using a named volume or dedicated disk. The app currently requires exactly one API instance; do not horizontally scale it.
- Caddy exposes ports 80/443 and obtains/renews TLS certificates automatically after DNS points to the VPS.
- Use separate staging and production VPSs or, at minimum, separate isolated services, databases, volumes, domains, environment files, SMTP credentials, provider accounts/modes, and encryption keys. Separate VPSs are preferable for a financial-data app.

## Phase 1 — buy and configure a domain

1. Choose a registrar and register a domain you control. Confirm renewal is enabled and account MFA is on. Avoid choosing a name that could be confused with another financial product.
2. Use a staging hostname such as staging.<your-domain> and a production hostname such as app.<your-domain> (or the apex domain if desired). Do not publish a live service before the release gate is met.
3. Create DNS A records pointing each hostname to its respective VPS IPv4 address. Add AAAA records only if IPv6 is actually configured and firewall-tested on that VPS.
4. Keep registrar/DNS account recovery codes in a secure password manager. DNS propagation can take time; verify resolution before requesting TLS.

## Phase 2 — provision and harden the VPS

- [ ] Choose a supported Ubuntu LTS image. For an initial small deployment, start around 2 vCPU, 4 GB RAM, and 40+ GB SSD, then monitor and resize as needed. This is a starting point, not a capacity guarantee.
- [ ] Create a non-root administrator account and install your SSH public key. Verify key login in a second session before changing SSH settings. Disable password-based SSH and root SSH login only after key access is confirmed.
- [ ] Apply OS security updates; enable automatic security updates.
- [ ] Configure the provider firewall and host firewall to allow inbound TCP 22 (preferably restricted to your IP), 80, and 443 only. Do not expose 4000, SQLite files, Docker API, or SSH to the whole internet unnecessarily.
- [ ] Install Docker Engine and the Docker Compose plugin from Docker's official Ubuntu instructions.
- [ ] Configure time synchronization, disk-space monitoring, and a non-root deployment procedure.
- [ ] Keep staging and production on separate hosts where possible; never copy live user data to staging.

## Phase 3 — deploy staging first

1. Keep the current PR open and unmerged. Once CI passes, deploy the PR branch only to the staging environment for validation; never deploy that branch as production.
2. Build the container from the exact reviewed commit. Do not build an image from an unreviewed pull request for production.
3. Configure a staging-only runtime environment using the VPS/provider's secret manager or a root-owned file outside the Git checkout with permissions restricted to the deployment account. Do not commit that file or put secrets in shell command arguments.
4. Use NODE_ENV=production and APP_ENV=staging so production security controls stay enabled while the app requires Stripe test mode and Plaid Sandbox.
5. Use a dedicated staging JWT_SECRET, staging SMTP account, staging-only Plaid token encryption key, Stripe test keys and test Price IDs, PLAID_ENV=sandbox, APP_BASE_URL=https://staging.<your-domain>, exact ALLOWED_ORIGINS, and a persistent DATABASE_PATH=/data/grounded.db. Configure every required SMTP variable from .env.example and the runbook. Never reuse production credentials.
6. Put Caddy in front of the app and proxy the staging hostname to 127.0.0.1:4000. Keep the app's published port bound to loopback.
7. Verify the HTTPS certificate, /api/health, sign-up/login, email verification and password reset delivery, expiry and one-time-token behavior, session invalidation after password reset, per-user financial-data isolation, Stripe test checkout/webhooks, Plaid Sandbox, exports/deletion, and no sensitive data in logs.
8. Restart and redeploy the container to prove the database survives. Create an encrypted backup, copy it off the VPS, and restore it into a separate staging database. Record the commit SHA, test results, and restore result.

## Phase 4 — durable backups and recovery

- [ ] Create a dedicated backup job on the host scheduler or backup service; the application container does not schedule backups by itself.
- [ ] Back up SQLite using scripts/backup-db.js and a dedicated backup encryption key. Keep the key outside the backup destination and outside the same VPS.
- [ ] Copy encrypted backups off-host to a separate storage account/bucket with access controls and retention/versioning. Use a different staging key from production; protect production key recovery separately.
- [ ] Alert on backup job failure, stale backups, disk exhaustion, and failed restore checks.
- [ ] Test restoration periodically and before releases. Never restore over the live database in place; restore to a new path, validate integrity and app behavior, then use a reviewed cutover procedure.
- [ ] Document retention, who can access backups/keys, and the recovery point/recovery time objectives.

## Phase 5 — production gate

Do not launch production until all of these are checked:

- [ ] The owner has reviewed and explicitly approved merging the release PR. No merge is authorized by this checklist.
- [ ] The exact release commit passes CI and the full staging acceptance checklist.
- [ ] Production uses a separate service/host, persistent volume, database, domain, SMTP identity, JWT secret, provider credentials, and token-encryption key.
- [ ] Set NODE_ENV=production, APP_ENV=production, PLAID_ENV=production only if Plaid Production access has been approved, Stripe live credentials and live Price IDs, exact production APP_BASE_URL and ALLOWED_ORIGINS, strong JWT secret, durable storage, and verified SMTP/domain authentication.
- [ ] Configure provider webhooks to the production HTTPS endpoint and verify signatures; keep live credentials out of staging and CI.
- [ ] Complete privacy policy, terms, support contact, incident response, monitoring, abuse/rate limiting, financial-data access review, and qualified security review.
- [ ] Verify encrypted off-host backups and a successful restore drill before accepting real financial data.
- [ ] Perform a controlled deployment with health checks and a rollback plan. Record deployed commit SHA and backup ID.

## Operational cautions

- SQLite is single-instance only. Before multi-instance scaling, move to a managed database and review session, migration, and backup design.
- Never place Plaid/Stripe private keys or JWT/encryption secrets in VITE_* variables; those can become browser-visible.
- Do not expose environment values in logs, screenshots, diagnostics, or support tickets.
- A passing Docker build is not proof of a deployed or secure production service.
