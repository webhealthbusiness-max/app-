# Grounded production readiness report

**Audit date:** 2026-10-15  
**Repository:** `webhealthbusiness-max/app-`  
**Reviewed branch:** `codex/comprehensive-remediation`  
**Reviewed code revision:** [`1a5e402d162ba2ef7d676cf0d0cf7e545616084e`](https://github.com/webhealthbusiness-max/app-/commit/1a5e402d162ba2ef7d676cf0d0cf7e545616084e)
**Pull request:** [#10](https://github.com/webhealthbusiness-max/app-/pull/10), draft, open, unmerged; based on PR #1's `ci-smoke-tests` branch.  
**Scope limit:** source, tests, GitHub history, and anonymous public HTTP requests. This is not a penetration test, legal opinion, provider certification, staging acceptance, or verification of the live container configuration. No production configuration, service, database, or financial data was changed.

## Executive decision

**Do not accept real financial data or enable live Plaid/Stripe integrations.** The code branch has meaningful fixes and passing CI, but the production asset incident is still active, staging has not been exercised, the deployed image/configuration is unknown, and recovery, provider, legal/privacy, and operational gates remain open.

## Phase 1 — production incident and repository reconciliation

### Confirmed public evidence

An anonymous GET probe was run against `https://www.mygroundedfinance.online` on 2026-10-15. The probe sent `Origin: https://www.mygroundedfinance.online` and then repeated each request without an Origin header:

| Request | With site Origin | Without Origin |
| --- | --- | --- |
| `/` | 403 `application/json` | 200 `text/html` |
| `/assets/index-uyI3Hzpm.js` | 403 `application/json` | 200 `text/javascript` |
| `/assets/index-CnYiRr1h.css` | 403 `application/json` | 200 `text/css` |
| `/api/health` | 403 `application/json` | 200 `application/json` |

The 403 responses include `X-Powered-By: Express` and JSON content type. The repository parses the exact allowlist and checks `APP_BASE_URL` at `server/index.js:147-148`; CORS rejects other origins at `server/index.js:340-349`, and the error handler maps that rejection to HTTP 403 at `server/index.js:1654-1657`. Static files are served by Express from `dist/` at `server/index.js:1633-1651`. This confirms an Origin-dependent rejection at the public application response boundary and reproduces the asset failure. It does not by itself prove which deployed process or configuration generated the response.

The automated `npm run check:deployment -- https://www.mygroundedfinance.online` probe returned homepage 200 but 403 for all six referenced assets and `/api/health`, then exited 1. This is a **failed production check**, not evidence of a repair.

### Root cause status

- **Confirmed:** requests carrying the canonical public Origin are rejected, including requests for the HTML page, static files, and health API. The public response behaves like an Express CORS rejection.
- **Strong hypothesis, not host-verified:** the live server's exact `ALLOWED_ORIGINS` list omits the canonical origin. This matches the response pattern and the code path.
- **Not ruled out:** another deployed Express version or middleware could emit the same rejection; the actual container image/build, live environment membership, and Caddy routing were not inspected.
- **Not indicated by current evidence:** a static-file permission error or missing asset as the direct cause. The no-Origin GETs returned the expected asset MIME types. The local reviewed build currently emits `index-CnYiRr1h.css` and `index-DKp0qFp8.js`, while production HTML references a different JS hash; that difference alone is not proof of a stale deployment because the release branch changes frontend code and its build naturally has different hashes.
- **Public proxy evidence:** Express's identifying header is present on the rejection response. No repository Caddyfile, Compose file, or live Caddy configuration is available to compare; Caddy-to-container route details remain unverified.

### Safe host checks needed to prove the configuration cause

Run these read-only checks on the IONOS host through an authorized administrator session. Do not print environment values, credentials, raw cookies, or unredacted application logs.

1. Record container metadata without `docker inspect` environment output:

   ```sh
   docker inspect --format 'name={{.Name}} image={{.Config.Image}} image_id={{.Image}} started={{.State.StartedAt}}' grounded-staging
   docker image inspect --format 'image_id={{.Id}} created={{.Created}}' "$(docker inspect --format '{{.Image}}' grounded-staging)"
   ```

2. Compare only boolean membership for the exact origin, without displaying the configured list:

   ```sh
   docker exec grounded-staging node -e 'const xs=(process.env.ALLOWED_ORIGINS||"").split(",").map(x=>x.trim()); console.log(JSON.stringify({configured:xs.some(Boolean),wwwAllowed:xs.includes("https://www.mygroundedfinance.online"),apexAllowed:xs.includes("https://mygroundedfinance.online")}))'
   ```

3. From the host, compare direct app and public Caddy responses for homepage, both current asset paths, and `/api/health`, once with the exact `Origin` header and once without it. Record only status, content type, and safe response headers. Do not send cookies or authorization headers.
4. Compare the image digest and running static directory file names/hashes with the approved source commit. Do not dump process environment or container filesystem secrets.
5. Correlate the failed request timestamps/status/path with Caddy and application access logs. Restrict output to request metadata; redact query strings, cookies, authorization, bodies, emails, and provider response details.
6. If a proxy/WAF is present, inspect its rule/action for these paths and timestamps. The Express header currently points to an app-level response, but host logs can confirm the route and middleware.

If the allowlist check is false and direct app requests reproduce the same 403, the likely repair is an exact-origin configuration update that preserves other intended origins, followed by a controlled restart and repeated checks. Do not use wildcard CORS. A production configuration update/restart requires the release owner's explicit operational approval.

## Phase 2 — security and correctness findings

| Severity | Finding and code location | Status / evidence | Remaining action |
| --- | --- | --- | --- |
| **P0 release blocker** | Live Origin-dependent 403; `server/index.js:147-148,340-349,1654-1657` | Reproduced by public GET and deployment checker; likely exact allowlist mismatch, but live config/image unavailable. | Prove runtime allowlist and image on IONOS; update exact origin only after approval; validate browser and checker. |
| **P1, fixed in this continuation** | Production could start with an `APP_BASE_URL` host that is absent from `ALLOWED_ORIGINS`, causing generated email/payment return links to target an origin that credentialed API calls reject. `server/origins.js`; startup integration in `server/index.js:147-148`, before SQLite opens at `154-160`. | Tests verify canonical origins, reject paths/invalid and insecure production origins, require the app base origin to be allowed, and confirm mismatch rejection occurs before creating/opening SQLite. Full local suite and GitHub CI pass. This prevents inconsistent configuration but does not prove or change the live allowlist. | Set matching exact HTTPS values in host configuration, then restart only through an approved release plan and verify the public site. |
| **P1, fixed in PR #10** | Production safeguards previously depended on inconsistent environment flags. Startup validation is now at `server/index.js:25-39`; regression tests in `tests/production-startup.test.js`. | Test suite verifies mismatched staging/production values and invalid `NODE_ENV` fail closed. | Stage using `NODE_ENV=production`, `APP_ENV=staging`; verify host has the intended settings without exposing values. |
| **P1, fixed in PR #10** | Plaid sync previously bounded pages without advancing the durable cursor; implementation in `server/plaid-sync.js`, route integration at `server/index.js:934-945,1006-1084`. | `tests/plaid-sync.integration.test.js` covers 12 pages, saved continuation after DB reopen, replay, add/modify/remove, and a partial provider failure; related unit tests cover bounded resume. | Exercise against Plaid Sandbox with synthetic users, then test outages/rate limits and stale-sync alerting. |
| **P1, fixed in PR #10** | Browser bearer JWT exposure and session revocation; `server/session-cookies.js`, `server/index.js:427-460`, `src/App.tsx`. | Production uses Secure, HttpOnly, SameSite session cookies, CSRF proof, session-version checks, and logout/reset revocation. Production integration tests pass. Frontend session storage is limited to non-production. | Verify Google sign-in and provider flows in staging. Consider opaque server-side sessions as a future architecture decision; current JWT cookie remains valid for up to seven days unless revoked/version-changed. |
| **P1, partly fixed** | Abuse limiting; `server/rate-limit.js`, `server/index.js:170-176` and route calls. | SQLite-persisted, HMAC-keyed IP/account buckets survive restart and avoid raw subject storage; tests cover persistence, expiry, bounds. | Appropriate only for one host/instance. Verify actual proxy hop and 429 behavior. Use a shared limiter before scaling. Add provider/email abuse monitoring and alerting. |
| **P1, source/test reviewed; external review remains** | API authentication and user-level ownership; shared `withUser` at `server/index.js:434-460`; route inventory in `docs/API-ACCESS-MATRIX.md`; cross-user tests in `tests/financial-access-control.integration.test.js`. | Source paths and synthetic tests cover private finance routes, task/notification mutations, and ownership predicates. Stripe persistence checks cross-user ID conflicts at `server/index.js:570-607`. | This was not an independent penetration test. Continue route-by-route review whenever endpoints change; staging test Plaid item isolation and concurrent mutations. |
| **P1, partly fixed** | Stripe webhook lifecycle; `server/index.js:362-424,570-607`; migrations `server/migrations.js`. | Raw-body signature verification, event ID claim/deduplication, stale event ordering, and cross-user billing identifier checks are implemented and tested. | Verify test-mode checkout, retry behavior, subscription update/cancel, account deletion, and webhook outage/replay in staging. No live Stripe test was performed. |
| **P2, partial** | CSP and security headers; `server/index.js:317-340`. | HSTS, nosniff, frame denial, referrer and permissions policies; CSP remains Report-Only. | It has no configured collector. Capture violations in staging with Google/Plaid/Stripe flows, refine the policy, then enforce only after compatibility testing. Do not claim CSP enforcement today. |
| **P2, partial** | Validation and input bounds; `server/validation.js`, route handlers in `server/index.js`, `tests/validation.test.js`. | Shared money/date/enum/boolean validation, request body limit (1 MiB), and field bounds have regression coverage. | Continue fuzz/abuse tests and assess password-reset/email rate limits at realistic traffic. No external penetration/fuzz run was performed. |
| **P2** | CSRF applies to mutating requests with the session cookie; `server/index.js:352-360`, `server/session-cookies.js`. | Signed CSRF cookie/header proof and failure cases are tested. CORS allowlist remains exact. | Test same-site/subdomain behavior and browser cookie behavior on the actual canonical staging domain. |
| **P2** | Safe logging; `server/safe-logging.js` and call sites in `server/index.js`. | Stable allowlist prevents arbitrary provider error text/code/name from being logged; secret-shaped regression test passes. | Host log retention/access, request correlation, redaction, alert routing, and incident ownership are unverified. |
| **P2** | Legal/privacy disclosure and retention; privacy/terms content in `server/index.js` and `README-PRODUCTION.md`. | Source explicitly labels disclosures as draft/pre-launch; README now accurately states recovery code is implemented and SMTP needs staging verification. | Qualified legal/privacy review; approve data inventory, purposes, processors, retention/deletion, support, billing and incident disclosures. |

### Authentication/session assessment

The present production session design reduces direct JavaScript access to the credential and has CSRF checks, but it is still a signed seven-day JWT held in a cookie, with per-request database lookup and session-version revocation. It is a reasonable scoped hardening step for this SQLite single-instance MVP; replacing it with opaque database-backed sessions is a separate architecture change that needs expiry, rotation, concurrent session, revocation, and migration design. Do not change it without those tests. CSP is only Report-Only, so XSS impact is reduced by HttpOnly but not eliminated: injected same-origin script could still act as the user.

## Phase 3 — financial correctness and Plaid

**Implemented and tested (P1 issue fixed):** transaction sync now fetches bounded pages, stores the latest successfully processed cursor with transaction changes, resumes on the next run, and applies additions/modifications/removals idempotently by provider transaction ID. A newly posted transaction removes its linked pending record. The integration tests use mocked Plaid responses and synthetic SQLite records only.

**Still open:**

- **P1 operational reliability issue:** sync is an in-process 15-minute timer at `server/index.js:936-945` and pauses on app downtime. The in-process duplicate guard is a `Map` in `server/plaid-sync.js:1-4`; it does not coordinate across processes. Add durable scheduling, bounded concurrency, retry/backoff/jitter, provider rate-limit handling, webhook/reconciliation strategy, and last-success/staleness alerts before claiming timely data.
- **P1 financial correctness issue:** transfer and amount classification is at `server/plaid-sync.js:82-90,107-114`; pending-to-posted replacement is at `server/plaid-sync.js:72-74`. The dashboard forecast is calculated from manual profile fields at `server/index.js:913-924`; imported account balances and transactions are returned separately. Define/test transfers, refunds, pending semantics, manual versus imported source-of-truth, balance freshness, time-zone/month boundaries, and forecast inclusion.
- **P1 precision issue:** amounts are parsed/calculated as JavaScript `Number` in dollar units (`server/validation.js:1-20`; manual transaction handling `server/index.js:1529-1546`). Most amount columns use SQLite `INTEGER` affinity (`server/migrations.js:16-25,53-102`), while account balances use `REAL` (`server/migrations.js:104-115`); SQLite can store fractional values in INTEGER-affinity columns. The schema does not enforce integer minor units. Define decimal representation and rounding policy before relying on financial records.
- Verify Plaid Sandbox connection, update, disconnect, and provider outage behavior. No real financial data was used.

## Phase 4 — database, migrations, backups, recovery

| Area | Current evidence | Remaining blocker |
| --- | --- | --- |
| SQLite | `server/index.js` opens SQLite with foreign keys and WAL. `Dockerfile` defaults to `/data/grounded.db`, creates `/data`, and runs as non-root. | IONOS mount, durability across replacement/reboot, correct ownership, free space, and single-instance deployment are unverified. SQLite and SQLite rate limiting require one API instance. |
| Migrations (**P1 before live upgrade**) | `server/migrations.js` applies versioned transactional migrations; `tests/migrations.test.js` verifies legacy upgrade, idempotency, and newer-schema refusal. | Run against a sanitized production-like snapshot and verify backup-first/rollback procedure. Do not run migrations against live data without a reviewed release plan. |
| Backup encryption (**P1 recovery gate**) | `scripts/backup-db.js` and `scripts/restore-db.js` use AES-256-GCM; restore refuses overwrite and validates SQLite integrity. `tests/backup-restore.test.js` covers synthetic round-trip, wrong key, tampering, and no-overwrite. | No host schedule, off-host upload, retention enforcement, alerting, key escrow/recovery exercise, or staging restore drill has been evidenced. |
| Recovery (**P1 recovery gate**) | `docs/BACKUP-RESTORE.md` documents restore to a new path and app-level validation. | Business owner must set RPO/RTO; exercise full IONOS/off-host restore and rollback, record time and integrity, and define data-deletion/backup expiry. |

No backup, off-host copy, or restore of production data was attempted.

## Phase 5 — external integrations

No SMTP, Stripe, Google, or Plaid credentials were used in CI or local tests. CI tests are synthetic/mocked and provider behavior remains unverified.

- **SMTP:** configure a staging-only sender/account and domain authentication; test verification, reset, notification, cancellation/deletion receipts, retries, bounce/failure handling, queue cleanup, and log redaction. Verify generic account-existence responses remain identical.
- **Stripe:** create only test-mode products/prices and webhook endpoint. Exercise checkout idempotency, success/cancel, duplicate and out-of-order events, subscription update/cancel, portal ownership, provider retry/outage, and account deletion. Keep live keys absent.
- **Plaid:** use Sandbox only with synthetic users/accounts. Test Link redirect where applicable, token exchange, multi-page sync, modifications/removals, reconnect, disconnect, rate limits/outage, cursor restart, and cross-user isolation. Request production approval separately; do not set production mode during staging.
- **Google Identity:** test configured staging client/audience, verified email, account linking, blocked/unavailable provider, and cookie session behavior. No provider credentials/client configuration was inspected.

## Phase 6 — release quality, deployment and operational readiness

**Automated checks present:** CI `.github/workflows/ci.yml` runs install, dependency audit, Node tests, checker syntax, Vite production build, Playwright Chromium E2E, and Docker build. The branch adds E2E coverage for built JS/CSS status and MIME, signup/splash, mocked login/dashboard loading, and generic password recovery. CI does not deploy.

**Deployment facts and gaps:** the repository includes a Dockerfile, but no Compose or Caddy configuration was found in the audited repository file list. The public deployment is known from the runbook/previous evidence to use AlmaLinux 9, Caddy, `grounded-staging`, and loopback port 4000, but direct Docker inspection was denied by socket permissions. Do not reinstall the host OS or infer live topology from the Dockerfile. Confirm Caddy routing, host firewall, TLS renewal, secret storage, persistent volume, image digest, deployed source SHA, permissions, and service restart policy on IONOS.

The production readiness remediation is on draft PR #10 and depends on open PR #1 as its base. Neither PR has been merged. Other open PRs exist (#3–#9); review and close/rebase superseded work before release. Do not merge a broad branch without reviewing the base diff and resolving unrelated PR history.

**Human/environment gates:** accessibility and real mobile/browser QA; monitoring and alert delivery; disk, backup and stale-bank alerts; incident response ownership; support/contact; current legal/privacy/financial-service review; provider terms/approval; data retention and deletion; and release/rollback owner.

## Tests and exact results

### Local checks run on reviewed code commit `1a5e402d162ba2ef7d676cf0d0cf7e545616084e`

- `PATH=/tmp/grounded-node-runtime/bin:$PATH npm test` — **passed: 44 tests, 0 failures** on Node v22.23.3.
- `PATH=/tmp/grounded-node-runtime/bin:$PATH npm audit --audit-level=moderate` — **passed: 0 vulnerabilities**.
- `PATH=/tmp/grounded-node-runtime/bin:$PATH npm run build` — **passed** (`tsc -b` and Vite); output included `dist/assets/index-DKp0qFp8.js` and `dist/assets/index-CnYiRr1h.css`.
- `git diff --check` — **passed**.
- `PATH=/tmp/grounded-node-runtime/bin:$PATH npm run check:deployment -- https://www.mygroundedfinance.online` — **failed as expected against the active incident**: page 200; six referenced assets 403; `/api/health` 403; exit code 1.

### GitHub Actions evidence

GitHub Actions run [#264](https://github.com/webhealthbusiness-max/app-/actions/runs/38685200094) on reviewed code commit `1a5e402d162ba2ef7d676cf0d0cf7e545616084e` completed successfully. It ran `npm ci`, `npm audit --audit-level=moderate`, `npm test`, deployment-checker syntax, frontend build, Playwright Chromium E2E, and Docker build. This proves those checks in GitHub's runner, not on IONOS or with real external services.

The local browser runtime is not a reliable substitute for CI because this AlmaLinux workspace lacks browser system libraries (`libnspr4.so`). No local Playwright success is claimed. The public deployment checker is intentionally recorded as failed.

Additional environment checks on this workspace:

- `PATH=/tmp/grounded-node-runtime/bin:$PATH npm run test:e2e` — **could not run assertions locally**: all three Playwright cases failed to launch Chromium because `libnspr4.so` is absent. GitHub Actions run #264 installed Chromium dependencies and passed the E2E step.
- `docker build --tag grounded-local-audit .` — **could not run locally**: Docker daemon access was denied for `/var/run/docker.sock`. GitHub Actions run #264 passed the Docker build step.

## Step-by-step staging acceptance tests

Use a separate staging host/service/database/domain where possible. Use synthetic records only, Plaid Sandbox, Stripe test mode, and staging SMTP. Never copy production user data to staging.

1. Build and deploy only the reviewed release commit to staging. Record Git SHA and image digest. Set `NODE_ENV=production`, `APP_ENV=staging`, an isolated durable SQLite path, exact HTTPS `APP_BASE_URL`/`ALLOWED_ORIGINS`, staging-only JWT/token/backup keys, SMTP credentials, Stripe test keys/prices, and Plaid Sandbox credentials. Keep all values in the host secret store; verify only required-setting presence, never values.
2. Confirm container is non-root, port 4000 is bound only to loopback, SQLite volume survives restart, health checks pass, HTTPS/TLS is valid, and only intended proxy hops are trusted.
3. Run `npm run check:deployment -- https://<staging-host>` from an authorized machine. Confirm page and all JS/CSS/images/manifest return success with correct MIME, and `/api/health` returns healthy JSON under the exact Origin. Load the site in Chromium and mobile viewport; confirm splash disappears and no console/network errors.
4. Register synthetic users A and B. Verify email delivery, one-time verification/expiry, login, cookie flags, CSRF rejection and success, logout revocation, password reset, reset session revocation, generic response for unknown accounts, and Google flow if enabled.
5. Create distinct manual finance records for A and B. Verify list/dashboard/export isolation, cross-user ID mutation denial, validation failures, rate limits, account deletion, and behavior when email/provider services fail.
6. In Plaid Sandbox, link a synthetic Item; sync more than ten pages, replay a page, modify/remove a transaction, convert pending to posted, force a partial failure, restart the process, and confirm cursor/data consistency, no duplicates, and visible last-success/failure state. Disconnect and delete synthetic data.
7. In Stripe test mode, run checkout, webhook success, duplicate delivery, out-of-order update, cancellation, portal ownership, provider retry/outage, and account deletion. Confirm no live Stripe mode/key is present.
8. Capture CSP Report-Only violations during ordinary app, Google, Plaid Link/OAuth, and Stripe flows. Refine and enforce only after zero expected violations and a rollback policy exist.
9. Run the scheduled encrypted backup against synthetic staging data, verify off-host object and retention behavior, restore to a new empty DB path, run integrity check and application smoke tests, and record duration/result. Restart and redeploy to prove volume durability.
10. Review logs for absence of credentials, tokens, email bodies, provider payloads, and financial records. Verify monitoring/alert delivery for API outage, disk pressure, failed/stale backup, stale bank sync, SMTP failure, and repeated auth abuse.

Acceptance evidence should include SHA/image digest, sanitized command results, screenshots or browser traces with all personal/token data removed, provider test event IDs only where safe, backup/restore record, and named release owner. Do not attach environment dumps or raw logs.

## Production deployment, verification, rollback and recovery

This report is a preparation guide; it does not authorize deployment. Do not merge PR #10, PR #1, alter production settings, restart production, migrate live data, or enable live providers until the release owner approves a concrete plan and all blockers are satisfied.

### Before deployment

1. Approve legal/privacy/terms/pricing/retention/support disclosures and external provider terms. Obtain Plaid production approval if bank linking is enabled.
2. Close staging acceptance, independent security review, accessibility review, sanitized migration upgrade, and full encrypted off-host restore drill. Set RPO/RTO and monitoring/on-call ownership.
3. Confirm source branch/base history is intentional; review PR #10's full diff and required checks. Build an immutable image from the approved commit and record its SHA/digest. Do not expose production credentials to CI or pull-request jobs.
4. Confirm exact production origin list, canonical URL, IONOS image/container, Caddy route, loopback-only binding, persistent volume, permissions, TLS, firewall, secrets, single-instance topology, and rollback artifact.
5. Take a verified encrypted pre-release backup and confirm the key recovery process. Never restore over the existing DB path.

### Deployment and verification

1. Apply the reviewed deployment/configuration change through the authorized IONOS release process, with operator and rollback owner present. Keep Plaid/Stripe live disabled until their own approvals and tests are complete.
2. Confirm deployed image digest/source SHA and migration version. Check `/health`, `/api/health`, homepage, every referenced asset's status and MIME, and API health with the canonical `Origin`.
3. Load the page in supported browsers and mobile viewport; verify login/recovery, core user-scoped dashboard, no console/network errors, cookie/security headers, and safe logs. Run the public deployment checker and retain only redacted status output.
4. Monitor error rate, 403s, latency, disk, database integrity, email queue, bank freshness, Stripe webhook outcomes, and backup alerts through the agreed observation window. Do not claim success until browser and network checks pass.

### Rollback and recovery

1. If health/assets/auth or data checks fail, pause the release and any impacted integration. Route traffic back to the previous immutable image using the approved host runbook. Keep the database/volume intact.
2. Do not roll back by deleting files or overwriting the live database. If a schema/data issue requires recovery, restore the verified encrypted backup to a **new** path using `npm run restore`, verify `integrity_check`, validate on an isolated service, and obtain a reviewed cutover decision.
3. Re-run health, same-origin asset/MIME, authentication/ownership, and data integrity checks after rollback. Record incident times, image SHA, migration state, backup ID, action owner, and user-notification/legal obligations.
4. Keep the failed image and backup protected for investigation under the approved retention policy; rotate credentials only through the secret manager if exposure is suspected.

## Prioritized release checklist

### Fixed in code, not deployed

- [x] Fail-closed production environment validation.
- [x] Resumable/replay-safe Plaid pagination and transaction changes.
- [x] Production cookie sessions, CSRF proof, logout/reset session revocation.
- [x] SQLite-backed single-instance rate limits and stronger route validation.
- [x] Stripe webhook signature/deduplication/order and billing ownership controls.
- [x] Versioned baseline migrations, encrypted backup/restore utilities, and safe logging.
- [x] Built-asset browser E2E and same-origin deployment check in CI.
- [x] Fail startup on invalid/noncanonical production origins or an `APP_BASE_URL` origin omitted from the CORS allowlist.
- [x] Validate production origins before creating/opening the SQLite database.
- [x] Documentation corrected for password recovery implementation and hardened staging mode.

These changes are in open draft PR #10, based on unmerged PR #1. They are not on the live service.

### Remaining blockers

- [ ] Prove and repair live exact-origin configuration; verify the browser and deployment checker pass.
- [ ] Inspect actual image/build identity, Caddy, volume, environment membership (boolean only), and restart policy on IONOS.
- [ ] Complete full staging acceptance, provider tests, CSP violation analysis, mobile/accessibility checks.
- [ ] Implement durable Plaid scheduling/failure alerting before promising freshness.
- [ ] Define financial source-of-truth, transfer/refund/pending/date behavior and fixed-precision money policy.
- [ ] Schedule, off-host, monitor, retain, and restore-test encrypted backups; set RPO/RTO.
- [ ] Validate migration/rollback against a sanitized production-like database.
- [ ] Add operational monitoring, alert ownership, incident response, and log-retention review.
- [ ] Complete independent security review and qualified legal/privacy/provider review.

### Owner or external access required

- **IONOS/host administrator:** Docker image/config/volume/Caddy inspection, exact origin configuration, staging host, restart/deploy, firewall/TLS/storage/monitoring, backup scheduler and off-host destination.
- **Plaid:** Sandbox setup and production approval/terms; use test mode only for acceptance.
- **Stripe:** test products/prices/webhook/portal validation; live billing decision, pricing/refunds/tax/support review later.
- **SMTP/domain:** authenticated staging sender, delivery and bounce testing; production sender reputation/configuration.
- **Business/legal/privacy owner:** data inventory, disclosures, retention/deletion/backup policy, terms, financial-service boundaries, user support and incident contact.
- **Release owner:** approve merge and production plan only after evidence above; decide RPO/RTO, maintenance window, rollback owner and acceptance criteria.

**Production status: NOT READY / INCIDENT ACTIVE.** Production remains untouched by this remediation work.
