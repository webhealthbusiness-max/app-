# Grounded deployment preparation and release gate

Grounded is not deployed yet. This document prepares the release process but does not create a hosting account, domain, DNS records, TLS certificate, persistent volume, or production service.

## Architecture

- Deploy the Vite frontend build output (`dist/`) to a static frontend host.
- Deploy the Express API as a Node.js service using Node 22.12 or newer.
- Route same-origin `/api/*` requests to the API; do not cache authenticated responses.
- Until SQLite is replaced, run exactly one API instance and attach durable persistent storage for `DATABASE_PATH`.
- Keep provider credentials and `JWT_SECRET` only in server-side secret managers, never in the frontend build.

## Staging first

- [ ] Choose a host that supports Node 22.12+, persistent storage, HTTPS, server-side secrets, health checks, and scheduled jobs or external backup scheduling.
- [ ] Configure staging with synthetic users/data, Plaid Sandbox, Stripe test mode, a staging-only encryption key, and SMTP test delivery.
- [ ] Set `NODE_ENV=production` only when exercising production startup checks on the staging deployment; never relax production checks just to get a test environment running.
- [ ] Configure `APP_BASE_URL` and `ALLOWED_ORIGINS` to exact HTTPS staging origins.
- [ ] Set a random `JWT_SECRET` of at least 32 characters, persistent `DATABASE_PATH`, complete SMTP settings, Stripe test-mode values, and Plaid Sandbox values.
- [ ] Run `npm ci`, `npm audit --audit-level=moderate`, `npm test`, and `npm run build` on the exact release commit.
- [ ] Verify external `/health` and `/api/health`, authentication, recovery/verification email, ownership tests, checkout/webhook test mode, bank sandbox, export/deletion, and a restore drill.
- [ ] Test restart, deploy rollback, database persistence, backup alerting, and restoring a backup into a separate staging database.

## Production gate

Do not deploy or enable live financial services until all blocking security and recovery items are verified. Production requires a real HTTPS domain, reviewed privacy/terms and billing disclosures, an operational support/incident owner, SMTP domain authentication, verified off-host encrypted backups, and a successful restore drill. Plaid Production access requires provider approval.

## Rollback

- Keep the previous release artifact and a verified pre-release backup.
- Define who can pause bank syncs, checkout, or account creation during an incident.
- Do not restore over the live database in place. Restore into a new path, validate integrity and application behavior, then follow a reviewed cutover plan.
- Record deployment SHA, migration status, health-check results, backup ID, rollback owner, and incident notes.

## Current status

No hosting provider or public domain has been selected. Production deployment cannot be completed until the owner creates/configures those external resources. Do not represent this runbook as a successful deployment.
