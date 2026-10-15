# Grounded production audit findings

**Scope:** source review of `origin/ci-smoke-tests` plus remediation in draft PR #10, branch `codex/comprehensive-remediation`. This is not a penetration test or legal/compliance opinion. The public CORS failure is confirmed by read-only HTTP probes. GitHub Actions run #234 passed for head `77ad8e104253b750d6223cc4a754e822725a2d22`: `npm ci`, `npm audit --audit-level=moderate`, all `npm test` tests, deployment-checker syntax, frontend build, and Docker build. Local native database tests could not run in this environment because the available `better-sqlite3` binding crashed under Node 22; CI provides the verified test result. Staging/provider, production-configuration, backup/restore, and legal/privacy checks remain outside this CI evidence.

## Release recommendation

**Do not accept real financial data or enable Plaid/Stripe live mode yet.** Keep PR #1 unmerged until high-priority code and operational blockers are addressed, tests pass, and staging is exercised.

## P0 — confirmed live-site release blocker

### Browser asset requests are rejected by the application's Origin check
**Evidence (read-only public requests, 2026-10-15):** the production homepage returns HTTP 200 through Caddy and references `/assets/index-uyI3Hzpm.js` and `/assets/index-CnYiRr1h.css`. Each asset returns HTTP 200 with its expected JavaScript/CSS MIME type when requested without an `Origin` header, but HTTP 403 `application/json` when requested with `Origin: https://www.mygroundedfinance.online` or `Origin: https://mygroundedfinance.online`. `/health` and `/api/health` show the same origin-dependent behavior. Responses identify Caddy as the proxy and Express as the application (`X-Powered-By`), matching `server/index.js` CORS middleware at lines 323–369 and its 403 handler at lines 1797–1798.

**Confirmed cause:** the running application's CORS middleware rejects both public site origins. The exact configured allowlist was not read or printed. The app's static asset URLs reach Express CORS middleware, which rejects the browser's origin before static-file serving. Originless VPS requests therefore conceal the problem.

**Safe repair:** configure `ALLOWED_ORIGINS` with the exact canonical public origins actually used by the site, preserving any other intentionally supported origins; do not use `*`. This is a live production configuration change and has not been made. After the owner approves the configuration update and restart, rerun the origin-bearing public asset/API checks and load the site in a browser. The deployment checker now sends the page origin with asset and health requests so CI/operations checks detect this failure.

**Hosting identity remains unverified:** public headers show Caddy forwarding to Express, but Docker API access is denied from this audit environment, so the live container image, bind mount, and deployed build SHA could not be compared with the branch.

## P1 — fix before production

### 1. Production environment consistency
**Evidence:** safeguards depend on `NODE_ENV=production`; `APP_ENV=staging|production` is rejected unless `NODE_ENV=production`.

**Status: FIX IMPLEMENTED IN DRAFT PR #10; CI PASSED.** Startup also rejects unknown `NODE_ENV` values so a typo such as `Production` cannot silently select development defaults. Regression tests cover mismatched and invalid values and passed in CI run #234.

### 2. Plaid sync can get stuck after more than 5,000 changes
**Evidence:** syncPlaidConnection in server/index.js stops after 10 pages of 500 transactions. When hasMore remains true, it stores the original connection.cursor instead of the last processed cursor.

**Failure mode:** the next sync starts from the same old cursor and can repeat the first 5,000 changes indefinitely, so later transaction changes may never arrive. The endpoint reports complete:false but has no durable continuation mechanism for the next batch.

**Status: FIX AND REGRESSION COVERAGE COMMITTED.** The sync persists the latest processed cursor atomically with transaction changes, so a bounded run continues from the saved cursor. `tests/plaid-sync.integration.test.js` uses synthetic provider data and SQLite to verify a 12-page sync across a database close/reopen boundary, duplicate transaction replay, added/modified/removed changes, and a provider failure on page 2 followed by a safe retry. On failure, neither the fetched page changes nor the cursor advance is committed. `tests/plaid-sync.test.js` also covers the 11-page bounded-resume behavior. GitHub Actions run #219 passed `npm test` for commit `2cc62a2362a9eadfe47ed1230e3f545fd2ff4e86`. The restart test closes/reopens SQLite and reconstructs the sync service in one test process; it is not a process-supervisor or deployed-container restart test.

### 3. Browser session token exposure
**Evidence:** the previous frontend stored the production bearer JWT in localStorage, where script injection could read it.

**Status: FIX IMPLEMENTED IN DRAFT PR #10; CI PASSED.** Production now issues Secure, HttpOnly, SameSite session cookies, signed CSRF tokens, revokes sessions on logout, and no longer returns JWTs in JSON. The frontend uses cookies in production and sessionStorage only in non-production. Unit and synthetic production integration tests passed in CI run #234. Browser E2E and staging compatibility with Google and Plaid remain unverified. CSP remains report-only and does not block script execution.

### 4. In-memory rate limits are not a production abuse-control system
**Evidence:** the previous implementation used a process-local Map keyed by IP, which reset on restart and lacked per-account limits.

**Failure mode:** restarts/replicas bypass limits; distributed attackers can spray password-reset/verification emails; users behind one shared IP can block each other; stale map entries are cleaned only when the map reaches its bucket cap.

**Status: SINGLE-HOST FIX IMPLEMENTED IN DRAFT PR #10; CI PASSED.** Rate-limit buckets persist in SQLite across app restarts, are HMAC-keyed rather than storing raw emails/IPs, bound key cardinality, and apply account/user keys alongside IP keys on signup, login, recovery, banking, and billing routes. Persistence, expiry, and key-bound tests passed in CI run #234. **Still required:** verify proxy IP trust and 429 behavior in staging. SQLite rate limits are only appropriate for a single-host/single-instance model; multi-host deployments require shared storage.

### 5. Production privacy/legal documents are not ready
**Evidence:** server/index.js labels the privacy page a pre-launch disclosure and says production retention, backup-erasure policy, and independent privacy review are missing. Terms are explicitly drafts. README-PRODUCTION.md lists counsel review and retention/deletion review as outstanding.

**Failure mode:** users may rely on incomplete or inaccurate disclosures about financial data, providers, retention, account deletion, subscription renewal, and support.

**Fix:** qualified review and finalization of privacy policy, terms, pricing/renewal/refund disclosures, data inventory, retention/deletion policy, support and incident contacts before launch. Verify actual behavior matches final disclosures. This is not solved by a code patch.

## P2 — resolve before public launch

### 6. Browser security policy and hardening validation are incomplete
**Evidence:** server sets nosniff, frame denial, referrer policy, permissions policy, and HSTS in production. A CSP `Report-Only` baseline was added, but enforcement and browser end-to-end tests are still absent.

**Status: PARTIAL FIX COMMITTED.** Production emits an initial `Content-Security-Policy-Report-Only` baseline without `unsafe-eval`. This policy does not block violations; without a configured `report-uri`/`report-to` collector, violations are visible primarily in browser developer tools rather than centrally collected. The latest code also allows manually triggering CI from GitHub Actions, and the deployment checker now fails if the page serves `/src/main.tsx` rather than a built bundle. **Still required:** confirm CI for the latest commit, validate in staging with Google/Plaid flows, add deliberate violation collection if desired, then refine and enforce a tested CSP; consider COOP/CORP where compatible and add browser E2E tests.

### 7. CI does not prove production is healthy
**Evidence:** CI performs install, audit, Node tests, Vite build, and Docker build. It does not verify IONOS reverse proxy rules, SMTP delivery, external provider webhooks, or a staging restore drill.

**Status: PARTIAL FIX COMMITTED.** The credential-free CI workflow can be manually dispatched. The deployment checker detects failed assets, incorrect JavaScript/CSS content types, and same-origin CORS rejection for assets and `/api/health`. It has now reproduced the current live CORS failure in read-only checks. **Still required:** configure the exact production allowlist with owner approval, run the checker after the change, add staging browser E2E using synthetic data and test credentials, and verify auth flows and cache headers. Never expose live provider secrets to untrusted PR jobs.

### 8. Backup scripts are not a backup service
**Evidence:** npm run backup creates an encrypted backup file but does not schedule it, transfer backups off-host, enforce retention, alert on failure/staleness, or prove a restore against the deployed volume.

**Fix:** schedule backups outside the API process, store encrypted copies in a separate account/location, separate backup keys from database/provider keys, monitor failures and disk use, define retention/RPO/RTO, and run/record a staging restore drill. Test crash/partial-write behavior and file permissions.

### 9. Plaid polling is an in-process timer, not a durable job system
**Evidence:** a 15-minute timer in server/index.js enumerates connected Items and starts sync jobs. The production runbook notes downtime pauses syncing.

**Failure mode:** sync pauses during restarts; large user counts create bursts; process crashes lose scheduling state; provider rate limits/transient errors can leave data stale without alerting.

**Fix:** before promising timely bank data, use a durable worker/scheduler or provider webhooks plus reconciled periodic jobs; bound concurrency, add backoff/jitter and stale-sync alerts, and expose last-success/error status.

### 10. Database migrations are ad hoc startup mutations
**Evidence:** server/index.js creates tables and runs conditional ALTER TABLE statements at process startup.

**Failure mode:** migration history, rollback, backup compatibility, and multi-process coordination are not formalized. A future schema change may fail partway or behave differently across deployed copies.

**Fix:** add numbered transactional migrations with a schema-version table; test upgrade from prior schema copies and rollback/restore; enforce a single migration runner before app startup.

### 11. Deployment settings and filesystem protections need verification
**Evidence:** SQLite is single-instance; database path is environment-defined; reverse-proxy trust is configurable. Repository review cannot verify actual IONOS permissions, durable storage, firewall, DNS, TLS, or publish directory.

**Fix:** retain AlmaLinux 9, secure database/backup directories and secrets, bind the app only to loopback behind HTTPS proxy, set TRUST_PROXY_HOPS only to the verified proxy chain, keep port 4000 private, verify data survives container replacement/reboot, and document rollback. Do not change live permissions/DNS by guesswork.

### 12. Documentation has drifted from the implementation
**Evidence:** parts of README-PRODUCTION.md still say email verification/password recovery are not implemented, while server/index.js and tests contain those flows. Staging email delivery and restore drills remain unverified, which is a separate claim.

**Fix:** reconcile every statement against current code; distinguish implemented, automated-tested, tested with a real staging provider, and production-verified. Keep one release checklist as source of truth.

## P3 — product/data quality and resilience

### 13. Validate financial/date fields consistently
**Evidence:** create routes sanitize strings but have inconsistent length bounds, enum validation, and date validation. Goals accept sanitized date/contribution strings without validating date format; task title/category/due strings lack maximum lengths; bill/income/subscription routes need consistent enum/range validation.

**Status: PARTIAL FIX IMPLEMENTED IN DRAFT PR #10; CI PASSED.** Shared validators now enforce cents precision, maximum values, calendar dates, frequency/status enums, and boolean types on account, goal, bill, income, and subscription creation. The bill/income/subscription forms use constrained frequency and date inputs. API regressions and frontend type/build checks passed in CI run #234. Money remains stored as SQLite `REAL`, so an integer-cents migration and finance domain rules remain open.

### 14. Finance calculations need explicit domain rules and tests
**Evidence:** dashboard safeToSpend/projectedBalance use profile arithmetic; manually entered transactions update current_money, while Plaid imports store transaction rows and connected-account balances separately. This may be intentional but the source-of-truth distinction needs tests.

**Fix:** define whether profile cash is independent from connected account balances, how transfers/refunds/pending transactions are treated, and whether imported transactions affect forecasts. Test income/expense signs, transfers, pending-to-posted replacement, duplicate syncs, timezone/month boundaries, and stale balances. Prevent double-counting imported data and manually entered totals.

### 15. Observability and support runbooks must be exercised
**Evidence:** code logs some provider/SMTP failures, but repository checks do not prove alert routing, request correlation, incident response, or deployed log redaction.

**Fix:** add request IDs and safe error classification; monitor auth abuse, 5xx, SMTP queue growth, stale Plaid syncs, backup age/failure, disk exhaustion, and Stripe webhook failures. Ensure logs exclude tokens, passwords, raw bank payloads, and unnecessary personal/financial data; assign a human response owner.

## Items requiring live/staging access

These cannot be conclusively determined from source alone:
- Whether public HTML references built assets or the Vite source entry.
- Whether the exact-origin production CORS allowlist repair has been applied and the app loads successfully in a real browser.
- Live container image/build identity, durable volume, and actual Caddy configuration (public Caddy-to-Express routing is confirmed from response headers, but Docker inspection was denied).
- DNS, certificate chain, TLS, firewall, SSH, and actual volume persistence.
- SMTP deliverability/domain authentication, Stripe test checkout/webhook lifecycle, Plaid Sandbox/OAuth redirect behavior.
- Off-host backup upload, key recovery, restore time, and deletion propagation through backups/providers.
- Accessibility, responsive behavior, browser-specific issues, and real-device performance.

## Suggested Codex execution order

1. Add fail-closed environment consistency tests and fix startup validation.
2. Fix/resume Plaid pagination safely and add >10-page tests.
3. Add rate-limit and field-validation tests; replace or formally constrain process-local limits.
4. Design XSS/session/CSP changes with threat-model tests.
5. Add schema migration/versioning.
6. Reconcile documentation and add browser/staging test plans.
7. Do not claim release readiness until staging, provider, backup/restore, and legal/privacy gates have evidence.
