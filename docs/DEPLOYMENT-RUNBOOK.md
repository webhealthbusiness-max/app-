# Grounded deployment preparation and release gate

Grounded is not deployed yet. This document prepares the release process but does not create a hosting account, domain, DNS records, TLS certificate, persistent volume, or production service.

## Architecture

- The included `Dockerfile` builds the Vite frontend and Express API into one Node 22 container; the API serves `dist/` from the same origin when the build is present. This is the simplest deployment option.
- Alternatively, deploy `dist/` to a static frontend host and the Express API to a separate Node 22.12+ service, routing same-origin `/api/*` requests to the API. Never cache authenticated responses.
- Until SQLite is replaced, run exactly one API instance and attach durable, writable persistent storage at `/data` (the container default `DATABASE_PATH=/data/grounded.db`). The container runs as the non-root `node` user, so verify the mounted volume permissions.
- Keep provider credentials and `JWT_SECRET` only in server-side secret managers, never in the frontend build.

## Staging first

- [ ] Choose a host that supports Docker or Node 22.12+, persistent storage, HTTPS, server-side secrets, health checks, and scheduled jobs or external backup scheduling.
- [ ] Build the release image with `docker build --tag grounded .` and test its `/api/health` health check before pushing it to a container registry.
- [ ] Configure staging with synthetic users/data, Plaid Sandbox, Stripe test mode, a staging-only encryption key, and SMTP test delivery.
- [ ] Set `NODE_ENV=production` and `APP_ENV=staging` on the staging API. This keeps production security controls (including email verification and required secret/storage checks) enabled while explicitly requiring Stripe test-mode keys and Plaid Sandbox.
- [ ] Configure `APP_BASE_URL` and `ALLOWED_ORIGINS` to exact HTTPS staging origins.
- [ ] Set a random `JWT_SECRET` of at least 32 characters, persistent `DATABASE_PATH`, complete staging SMTP settings, Stripe test-mode values (`sk_test_...` and test Price IDs), and Plaid Sandbox values (`PLAID_ENV=sandbox`) with a staging-only token-encryption key.
- [ ] Run `npm ci`, `npm audit --audit-level=moderate`, `npm test`, and `npm run build` on the exact release commit.
- [ ] Verify external `/health` and `/api/health`, authentication, recovery/verification email, one-time token expiry, session revocation after password reset, ownership tests, checkout/webhook test mode, bank sandbox, export/deletion, and a restore drill.
- [ ] Test restart, deploy rollback, database persistence, backup alerting, and restoring a backup into a separate staging database. Configure the host's scheduler/cron service separately; the container does not schedule backups by itself.

## Production gate

Do not deploy or enable live financial services until all blocking security and recovery items are verified. Set `APP_ENV=production` for the live API. Production requires a real HTTPS domain, reviewed privacy/terms and billing disclosures, an operational support/incident owner, SMTP domain authentication, verified off-host encrypted backups, and a successful restore drill. Production mode requires a Stripe live secret key and, when Plaid is configured, `PLAID_ENV=production`. Plaid Production access requires provider approval.

## Rollback

- Keep the previous release artifact and a verified pre-release backup.
- Define who can pause bank syncs, checkout, or account creation during an incident.
- Do not restore over the live database in place. Restore into a new path, validate integrity and application behavior, then follow a reviewed cutover plan.
- Record deployment SHA, migration status, health-check results, backup ID, rollback owner, and incident notes.

## Current status

Hosting choice: VPS. Domain: not yet registered/configured. The next action is to register a domain and provision a hardened VPS, then deploy to staging first using docs/VPS-DEPLOYMENT-CHECKLIST.md. No VPS, DNS, TLS certificate, persistent volume, or production service has been created by this preparation. Do not represent this runbook as a successful deployment.
