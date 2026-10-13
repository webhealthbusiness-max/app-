# Grounded Production Launch Checklist

This guide lists the work required to take Grounded from its current development/MVP state to a responsible public launch. It is a checklist, not a declaration that the app is production-ready. Do not accept real financial data or enable live bank connections until the blocking items below have been completed and verified.

## Current implementation and important limitations

- The frontend is built with `npm run build`; the API is the Express server started with `npm start`.
- When the Vite `dist/` folder exists, the Node API can serve the built frontend and SPA routes from the same origin; this supports a single-service deployment. If you instead host the frontend separately, configure same-origin `/api/*` routing through a reverse proxy and ensure authenticated API responses are never cached.
- The API currently uses SQLite and is designed for one API instance. A persistent volume is necessary even for a single-instance deployment. Before scaling or requiring high availability, migrate to a managed database and replace SQLite-specific code.
- Signup/login rate limits are kept in process memory; they do not coordinate across API instances or survive restarts.
- Plaid syncing currently runs in the API process approximately every 15 minutes, in addition to connection-time and user-requested sync. It is not a durable job queue; process restarts or downtime pause automatic syncing.
- In-app notifications are implemented. Outbound email requires SMTP configuration.
- Google sign-in is optional and requires OAuth credentials.
- Stripe configuration is required by the current production startup checks. Plaid is optional at startup, but must be configured and approved before enabling real bank connections.
- Privacy, terms, and copyright pages are drafts. They are not legal advice or compliance approval.

## 1. Make the launch decisions

- [ ] Choose a supported hosting provider for the static frontend and Node API. Confirm Node.js 22.12 or newer, outbound HTTPS, health checks, persistent storage if SQLite is retained, scheduled-process behavior, and secret-manager support.
- [ ] Choose the public domain and canonical HTTPS origin, for example `https://your-domain.example`. Configure DNS and TLS before production OAuth, Stripe, or Plaid testing.
- [ ] Decide whether to start with a limited invite-only launch or a public launch. Set user/support capacity and an incident contact before accepting customers.
- [ ] Confirm the advertised prices: **$5.99/month and $59.99/year USD**, plus any applicable tax. These are the current app defaults and should not be sold until confirmed.
- [ ] Decide whether Plaid will be enabled at launch. If not, leave all Plaid credentials unset and keep bank linking disabled.
- [ ] Assign an owner for production alerts, support requests, data deletion requests, security incidents, and billing disputes.

## 2. Finish production architecture before real user data

- [ ] **Choose and implement the production data store.** For multiple instances or high availability, migrate from SQLite to a managed database and replace SQLite-specific SQL/driver usage. Do not point multiple API instances at one SQLite file.
- [ ] If temporarily using one API instance with SQLite, place `DATABASE_PATH` on the provider's durable persistent volume, confirm the volume survives deploys/restarts, restrict filesystem access, and document the single-instance outage and scaling limits.
- [ ] Add an automated encrypted backup schedule, defined retention period, access controls, and a documented restore procedure. Perform a restore drill before launch and on a recurring schedule.
- [ ] Add a reviewed schema migration process. Test migrations against a production-like copy before deployment; keep rollback/restore instructions.
- [ ] Replace the in-memory rate limiter with shared storage before scaling beyond one process. Review limits for auth, Google sign-in, checkout, notifications, and bank-link/sync endpoints.
- [ ] Use a durable background job/worker for scheduled bank syncs and email retries if those operations must continue through API restarts or multiple instances. Ensure only one worker processes each user's bank cursor at a time.
- [ ] Confirm the frontend static host forwards `/api/*` to the API without caching authenticated responses. The API sets `Cache-Control: no-store` on API paths; verify the CDN/proxy honors it.
- [ ] Configure reverse-proxy trust only for the actual number of trusted hops using `TRUST_PROXY_HOPS`; do not trust arbitrary client-supplied forwarding headers.

## 3. Prepare the application and deployment

- [ ] Review all changes and environment settings on the intended release branch. Do not deploy local test databases, build artifacts, `.env` files, or credentials.
- [ ] Use Node.js 22.12+ and run from a clean checkout:

  ```bash
  npm ci
  npm audit --audit-level=moderate
  npm test
  npm run build
  ```

- [ ] Build the frontend and deploy the resulting `dist/` directory to the static host.
- [ ] Confirm `/manifest.webmanifest` and the Grounded 180, 192, and 512 pixel icons are served from the frontend origin; test the branded launch screen in a mobile browser and, where supported, as an installed web app.
- [ ] Deploy the API with `npm start` to a Node service. Configure a persistent writable location for `DATABASE_PATH` if retaining SQLite.
- [ ] Configure the static host/reverse proxy so `https://your-domain.example/api/...` reaches the API and `/` serves the frontend. Confirm the frontend's relative `/api` requests work in production.
- [ ] Set `NODE_ENV=production`, `PORT` as supplied by the host, and `APP_BASE_URL` to the public HTTPS origin.
- [ ] Set `ALLOWED_ORIGINS` to the exact trusted frontend origin(s), comma-separated, with no localhost or wildcard origins.
- [ ] Create a random `JWT_SECRET` of at least 32 characters. Store it only in the host's secret manager; do not put it in source control, frontend variables, logs, screenshots, or issue comments.
- [ ] Set `DATABASE_PATH` to the durable production volume. Restrict database and volume access to the API service.
- [ ] Set `TRUST_PROXY_HOPS` only if the deployment is behind a known trusted proxy and the hop count is verified.
- [ ] Start the service and verify `GET /health` and `GET /api/health` from outside the host. Confirm database health, HTTPS, API routing, and expected process restart behavior.
- [ ] Configure an uptime monitor for the health endpoint, error tracking, structured logs, alert routing, and a documented on-call/incident owner. Do not log passwords, tokens, full bank payloads, or sensitive finance data.
- [ ] Configure CI to require the existing test/build/audit workflow to pass before production deployment. Keep dependencies patched and repeat the audit on a regular schedule.

## 4. Configure email notifications

The current production startup guard requires complete SMTP settings.

- [ ] Choose an email provider suitable for transactional/security messages. Gmail SMTP with an App Password is available, but a dedicated transactional email provider is generally easier to operate at production volume.
- [ ] Verify the sender domain with the provider and configure SPF, DKIM, and DMARC records as directed by the provider.
- [ ] Store the provider credentials in the production secret manager and set:
  - `SMTP_HOST`
  - `SMTP_PORT` (465 for implicit TLS or a provider-supported STARTTLS port)
  - `SMTP_USER`
  - `SMTP_PASS`
  - `SMTP_FROM`
- [ ] Never use a regular Gmail account password. For Gmail SMTP, use an App Password and restrict access to the sending account.
- [ ] Test delivery, bounce/rejection behavior, retries, sender identity, spam placement, and support contact details using controlled email addresses.
- [ ] Decide and disclose which alerts are sent. The current app emails account creation, sign-ins, manual account additions, account deletion requests, and billing status changes when SMTP is enabled.
- [ ] Ensure queued email records and logs have documented retention and access policies.

## 5. Configure authentication

- [ ] Decide whether Google sign-in will be offered at launch. It is optional.
- [ ] If enabled, create a Google OAuth **Web application** client ID and authorize only the exact HTTPS production origin(s).
- [ ] Set the same public client ID as `GOOGLE_CLIENT_ID` for the API and `VITE_GOOGLE_CLIENT_ID` for the frontend build. The frontend variable is public by design; never put a Google client secret there.
- [ ] Rebuild the frontend after setting `VITE_GOOGLE_CLIENT_ID`, then deploy both frontend and API configuration.
- [ ] Test first-time Google signup, existing verified-email account linking, sign-in, rejected/expired credentials, and email notifications.
- [ ] Test password signup/login, duplicate signups, invalid credentials, rate limiting, logout, and expired sessions over HTTPS.
- [ ] Before a public launch, implement and test email verification and password reset, and review session/token storage and revocation. Consider MFA based on the threat model. These workflows are not currently implemented.
- [ ] Add clear support instructions for a user who did not initiate a security alert.

## 6. Configure Stripe and confirm billing

The production API currently refuses to start unless Stripe is configured and the secret key is a live key.

- [ ] Create/verify the Stripe business account and complete any identity/business verification Stripe requires.
- [ ] Confirm pricing and create active recurring USD Prices for exactly $5.99/month and $59.99/year. The API checks configured price currency, amount, recurrence, and active status.
- [ ] Enable and configure the Stripe Customer Portal, including cancellation and payment-method management.
- [ ] Create a production webhook pointing to `https://your-domain.example/api/billing/webhook`. Subscribe to:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
- [ ] Put the live API secret key, webhook signing secret, and both Price IDs in the production secret manager:
  - `STRIPE_SECRET_KEY` (`sk_live_...`)
  - `STRIPE_WEBHOOK_SECRET`
  - `STRIPE_PRICE_MONTHLY`
  - `STRIPE_PRICE_ANNUAL`
- [ ] Set `APP_BASE_URL` to the public HTTPS origin.
- [ ] Use Stripe test mode first. Test monthly and annual checkout, verified webhook activation, webhook retries/out-of-order events, cancellation, payment failure, portal management, duplicate checkout attempts, and account deletion with an active subscription.
- [ ] Confirm customer support contact, refund/cancellation terms, renewal disclosures, tax handling, receipts, and dispute procedures. Obtain legal review before charging customers.
- [ ] Switch to live credentials only after the test checklist passes and the business is ready to support paid users. Never mix test Price IDs with live Stripe keys.

## 7. Decide whether to enable Plaid bank connections

Keep Plaid unset to leave bank connection disabled. Sandbox is for synthetic/test data only; never connect a real bank using Sandbox.

- [ ] Create a Plaid application and test the full flow in **Sandbox** before requesting or enabling production access.
- [ ] Obtain Plaid approval for Transactions, target countries, business model, branding, and production access. Review current product pricing, institution coverage, contracts, and data-use obligations directly with Plaid.
- [ ] Set production secrets only after approval:
  - `PLAID_ENV=production`
  - `PLAID_CLIENT_ID`
  - `PLAID_SECRET`
  - `BANK_TOKEN_ENCRYPTION_KEY`, generated as 64 hex characters / 32 bytes (for example, `openssl rand -hex 32`)
- [ ] Store `BANK_TOKEN_ENCRYPTION_KEY` in the production secret manager and create a secure, access-controlled backup. Losing or rotating the key without re-encrypting existing tokens makes existing connections unusable.
- [ ] If using institutions that require OAuth redirects, set `PLAID_REDIRECT_URI` to the exact HTTPS URL registered with Plaid and verify the redirect/resume flow on the production domain.
- [ ] Require explicit user consent and clearly explain which accounts/data will be accessed, why it is used, how often it syncs, and how to disconnect and request deletion.
- [ ] Test Link cancellation, failed connections, duplicate link attempts, multiple selected accounts, reconnects, MFA/step-up bank auth, OAuth redirects, initial history import, modified/removed/pending transactions, categorization, balance refresh, and provider errors.
- [ ] Test that a user cannot access another user's Items, accounts, transaction records, or sync endpoints.
- [ ] Verify disconnect revokes the provider Item and removes its imported local accounts and transactions. Verify account deletion revokes every Item; if provider revocation fails, deletion must fail visibly rather than claim success.
- [ ] Confirm current sync behavior and freshness limits with Plaid and financial institutions. The current in-process 15-minute poll is not a durable production scheduler and should be replaced with reliable jobs/webhook-driven refresh before relying on timely data.
- [ ] Ensure monitoring and logs capture provider error codes and request IDs where useful, but do not log access tokens, public tokens, full transaction payloads, account numbers, or unnecessary personal/financial data.

## 8. Legal, privacy, security, and support readiness

- [ ] Have qualified counsel review and finalize `/privacy`, `/terms`, `/copyright`, pricing/renewal disclosures, refund/cancellation policy, and all claims about financial planning and connected accounts. Current documents are drafts.
- [ ] Determine applicable privacy, consumer-finance, data-broker, breach-notification, tax, and subscription laws for the countries/states served. Get specialist advice; do not treat this guide as legal advice.
- [ ] Publish an accurate data inventory: account/profile data, manual and imported financial data, Google identity fields, notifications/email queue data, Stripe identifiers, Plaid data, logs, backups, subprocessors, purposes, retention, and deletion process.
- [ ] Define retention and deletion periods for the production database, Plaid provider data, Stripe/customer records, email queue, application logs, backups, and support systems. Test the entire deletion chain, including backup expiry.
- [ ] Complete an independent security review of authentication, authorization/data isolation, secret handling, token encryption, rate limits, dependency/supply-chain risks, SQL migrations, webhook verification, deletion, and deployment configuration. Remediate findings before real financial data.
- [ ] Review HTTPS/TLS, secure headers, CORS, proxy configuration, database encryption/access, filesystem permissions, backups, least-privilege secrets, log redaction, vulnerability response, and incident response.
- [ ] Add documented procedures for security incidents, account compromise, unauthorized bank connections, provider outages, email delivery failures, data-subject requests, payment disputes, and customer support.
- [ ] Add browser end-to-end tests and accessibility review, including keyboard-only use and screen-reader labels for the bank consent/link and account controls.
- [ ] Perform real-device QA on supported phones/tablets and current desktop browsers at the actual production domain.

## 9. Final release and rollback

- [ ] Confirm all applicable checkboxes in Sections 1–8 are complete and evidence is recorded by the responsible owner.
- [ ] Confirm production secrets are present in the secret manager and absent from Git history, frontend bundles, logs, and build artifacts. Rotate any credential that was accidentally exposed.
- [ ] Take a verified backup immediately before the release and confirm the restore plan and rollback owner.
- [ ] Deploy first to a production-like staging environment with test Stripe/Plaid credentials and synthetic data. Test the release candidate end to end.
- [ ] Deploy the approved release. Verify `/health`, `/api/health`, signup/login, account data isolation, the mobile launch screen, email alerts, Google sign-in if enabled, Stripe webhooks/checkout, and Plaid Sandbox or approved production test flow.
- [ ] Monitor logs, health checks, errors, email queue failures, database growth, provider syncs, and support channels closely after release.
- [ ] If any check fails, disable the affected integration (Stripe/Plaid/Google as appropriate), roll back the application release or restore the verified backup, and notify affected users where required.
- [ ] Do not announce public availability until the release owner confirms the production checks passed and support/incident coverage is active.

## Production environment variable checklist

Required by the current production startup checks:

```text
NODE_ENV=production
APP_ENV=production
PORT=<port supplied by host>
JWT_SECRET=<random secret, at least 32 characters>
ALLOWED_ORIGINS=https://your-domain.example
DATABASE_PATH=<durable production volume path>
APP_BASE_URL=https://your-domain.example
STRIPE_SECRET_KEY=<live Stripe secret>
STRIPE_WEBHOOK_SECRET=<live webhook signing secret>
STRIPE_PRICE_MONTHLY=<active $5.99 USD/month Price ID>
STRIPE_PRICE_ANNUAL=<active $59.99 USD/year Price ID>
SMTP_HOST=<production SMTP host>
SMTP_PORT=<provider TLS port>
SMTP_USER=<SMTP user>
SMTP_PASS=<SMTP credential>
SMTP_FROM=<verified sender address>
```

Optional:

```text
GOOGLE_CLIENT_ID=<Google OAuth Web client ID>
VITE_GOOGLE_CLIENT_ID=<same ID; public frontend build variable>
TRUST_PROXY_HOPS=<verified integer from 1 to 5, only behind trusted proxies>
```

Only set these after Plaid production approval:

```text
PLAID_ENV=production
PLAID_CLIENT_ID=<Plaid client ID>
PLAID_SECRET=<Plaid production secret>
BANK_TOKEN_ENCRYPTION_KEY=<64 hexadecimal characters>
PLAID_REDIRECT_URI=<optional registered HTTPS OAuth redirect>
```

After setting production environment variables, restart/redeploy the API. Rebuild and redeploy the frontend whenever `VITE_GOOGLE_CLIENT_ID` changes.


## Authentication recovery and encrypted backups

- Production signup now requires email verification; the API creates a single-use token whose hash is stored in SQLite, and login is blocked until verification. Verification links expire after 24 hours.
- Password reset requests use generic responses to avoid confirming whether an email is registered. Reset tokens are hashed, expire after one hour, are single-use, and reset the account password. Reset increments the session version so existing bearer sessions are rejected.
- Email verification and password reset require working SMTP in production. Test these flows in staging using synthetic accounts and a dedicated test email provider before release.
- Generate a separate `BACKUP_ENCRYPTION_KEY` using `openssl rand -hex 32`; keep it separate from `BANK_TOKEN_ENCRYPTION_KEY`. Do not put it in source control or a frontend variable.
- `npm run backup` creates an AES-256-GCM encrypted SQLite backup. `npm run restore` restores an encrypted backup to a new, non-existing path and runs SQLite integrity_check before writing it. See [docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md).
- These scripts and recovery flows must pass CI and a real staging restore/email drill before they can be considered production-ready. Off-host backup retention, scheduling, alerting, and a tested production restore procedure are still required.
- See [docs/SECURITY-ACCESS-CONTROLS.md](docs/SECURITY-ACCESS-CONTROLS.md) for the route-by-route financial-data authorization checklist and [docs/DEPLOYMENT-RUNBOOK.md](docs/DEPLOYMENT-RUNBOOK.md) for deployment gates.
