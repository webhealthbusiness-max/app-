# Grounded production audit findings

**Scope:** source review of `origin/ci-smoke-tests` plus remediation in draft PR #10, branch `codex/comprehensive-remediation`. This is not a penetration test or legal/compliance opinion. GitHub Actions run [#264](https://github.com/webhealthbusiness-max/app-/actions/runs/38685200094) passed on code head `1a5e402d162ba2ef7d676cf0d0cf7e545616084e`: `npm ci`, `npm audit --audit-level=moderate`, `npm test`, deployment-checker syntax, frontend build, Playwright Chromium E2E, and Docker build. Current local Node 22.23.3 checks also pass 44 tests, the audit (zero vulnerabilities), and frontend build. Local Playwright could not launch because `libnspr4.so` is absent; local Docker build was denied by Docker socket permissions. Staging/provider, production-configuration, backup/restore, and legal/privacy checks remain outside this CI evidence. See [the consolidated production readiness report](PRODUCTION-READINESS-REPORT.md) for current results and release steps.

## Release recommendation

**Do not accept real financial data or enable Plaid/Stripe live mode yet.** Keep PR #1 unmerged until high-priority code and operational blockers are addressed, tests pass, and staging is exercised.

## P0 — confirmed live-site release blocker

### Browser asset requests are rejected by the application's Origin check
**Evidence (read-only public requests, 2026-10-15):** without an `Origin` header the production homepage returns HTTP 200 through Caddy and references `/assets/index-uyI3Hzpm.js` and `/assets/index-CnYiRr1h.css`; the assets return 200 with JavaScript/CSS MIME types. With `Origin: https://www.mygroundedfinance.online`, fresh GET requests for the homepage, both assets, and `/api/health` all return HTTP 403 `application/json`; the responses include `X-Powered-By: Express`. The current responses reproduce the browser failure at the public boundary. In the branch source, `server/index.js:340-349` rejects origins absent from `allowedOrigins`, and `server/index.js:1654-1657` maps that error to HTTP 403. This is consistent with an exact allowlist mismatch, but the Docker API remains inaccessible from this environment, so the live process source/configuration could not be inspected directly and the exact deployed root cause is unproven. See [the consolidated production readiness report](PRODUCTION-READINESS-REPORT.md) for safe host checks and full acceptance/recovery steps.

**Confirmed at the public HTTP boundary:** a request carrying the public site Origin is rejected before it can receive the asset, while the homepage is served. The repository's CORS middleware is an exact code path capable of returning this response. **Most likely cause:** the live process allowlist does not contain the canonical browser origin. The exact running image, configuration, and middleware version have not been inspected, so attributing the live response to that precise deployed code remains a high-confidence hypothesis rather than direct host-level proof. Asset hash/build mismatch is not indicated by this response pattern but has not been ruled out by comparing the running image.

**Safe repair:** configure `ALLOWED_ORIGINS` with the exact canonical public origins actually used by the site, preserving any other intentionally supported origins; do not use `*`. This is a live production configuration change and has not been made. After the owner approves the configuration update and restart, rerun the origin-bearing public asset/API checks and load the site in a browser. The deployment checker now sends the page origin with asset and health requests so CI/operations checks detect this failure.

**Additional code safeguard:** `server/origins.js` now rejects malformed/noncanonical allowlist entries and, in production, non-HTTPS or loopback origins. Startup also fails when `APP_BASE_URL`'s origin is missing from the exact allowlist, before opening or creating the SQLite file. `tests/origins.test.js` and a production-startup regression test cover these conditions. This detects configuration drift before startup but does not alter or prove the live host settings.

**Hosting identity remains unverified:** public headers show Caddy forwarding to Express, but Docker API access is denied from this audit environment, so the live container image, bind mount, and deployed build SHA could not be compared with the branch.

## P1 — fix before production

### 1. Production environment consistency
**Evidence:** safeguards depend on `NODE_ENV=production`; `APP_ENV=staging|production` is rejected unless `NODE_ENV=production`.

**Status: FIX IMPLEMENTED IN DRAFT PR #10; CI PASSED.** Startup also rejects unknown `NODE_ENV` values so a typo such as `Production` cannot silently select development defaults. Regression tests cover mismatched and invalid values and passed in CI run #264.

### 2. Plaid sync can get stuck after more than 5,000 changes
**Evidence:** syncPlaidConnection in server/index.js stops after 10 pages of 500 transactions. When hasMore remains true, it stores the original connection.cursor instead of the last processed cursor.

**Failure mode:** the next sync starts from the same old cursor and can repeat the first 5,000 changes indefinitely, so later transaction changes may never arrive. The endpoint reports complete:false but has no durable continuation mechanism for the next batch.

**Status: FIX AND REGRESSION COVERAGE COMMITTED.** The sync persists the latest processed cursor atomically with transaction changes, so a bounded run continues from the saved cursor. `tests/plaid-sync.integration.test.js` uses synthetic provider data and SQLite to verify a 12-page sync across a database close/reopen boundary, duplicate transaction replay, added/modified/removed changes, and a provider failure on page 2 followed by a safe retry. On failure, neither the fetched page changes nor the cursor advance is committed. `tests/plaid-sync.test.js` also covers the 11-page bounded-resume behavior. GitHub Actions run #219 passed `npm test` for commit `2cc62a2362a9eadfe47ed1230e3f545fd2ff4e86`. The restart test closes/reopens SQLite and reconstructs the sync service in one test process; it is not a process-supervisor or deployed-container restart test.

### 3. Browser session token exposure
**Evidence:** the previous frontend stored the production bearer JWT in localStorage, where script injection could read it.

**Status: FIX IMPLEMENTED IN DRAFT PR #10; CI PASSED.** Production now issues Secure, HttpOnly, SameSite session cookies, signed CSRF tokens, revokes sessions on logout, and no longer returns JWTs in JSON. The frontend uses cookies in production and sessionStorage only in non-production. Unit and synthetic production integration tests passed in CI run #264. The added browser E2E suite covers built asset delivery and mocked login/dashboard/recovery; staging compatibility with Google and Plaid remains unverified. CSP remains report-only and does not block script execution.

### 4. In-memory rate limits are not a production abuse-control system
**Evidence:** the previous implementation used a process-local Map keyed by IP, which reset on restart and lacked per-account limits.

**Failure mode:** restarts/replicas bypass limits; distributed attackers can spray password-reset/verification emails; users behind one shared IP can block each other; stale map entries are cleaned only when the map reaches its bucket cap.

**Status: SINGLE-HOST FIX IMPLEMENTED IN DRAFT PR #10; CI PASSED.** Rate-limit buckets persist in SQLite across app restarts, are HMAC-keyed rather than storing raw emails/IPs, bound key cardinality, and apply account/user keys alongside IP keys on signup, login, recovery, banking, and billing routes. Persistence, expiry, and key-bound tests passed in CI run #264. Production now defaults to one trusted proxy hop, matching the documented Caddy-to-app topology; verify the actual chain and 429 behavior in staging. SQLite rate limits are only appropriate for a single-host/single-instance model; multi-host deployments require shared storage.

### 5. Production privacy/legal documents are not ready
**Evidence:** server/index.js labels the privacy page a pre-launch disclosure and says production retention, backup-erasure policy, and independent privacy review are missing. Terms are explicitly drafts. README-PRODUCTION.md lists counsel review and retention/deletion review as outstanding.

**Failure mode:** users may rely on incomplete or inaccurate disclosures about financial data, providers, retention, account deletion, subscription renewal, and support.

**Fix:** qualified review and finalization of privacy policy, terms, pricing/renewal/refund disclosures, data inventory, retention/deletion policy, support and incident contacts before launch. Verify actual behavior matches final disclosures. This is not solved by a code patch.

## P2 — resolve before public launch

### 6. Browser security policy and hardening validation are incomplete
**Evidence:** server sets nosniff, frame denial, referrer policy, permissions policy, and HSTS in production. A CSP `Report-Only` baseline was added, but enforcement and staging compatibility validation are still absent.

**Status: PARTIAL FIX COMMITTED; CI PASSED.** Production emits an initial `Content-Security-Policy-Report-Only` baseline without `unsafe-eval`. This policy does not block violations; without a configured `report-uri`/`report-to` collector, violations are visible primarily in browser developer tools rather than centrally collected. `style-src` now avoids broad inline style permission while `style-src-attr` allows React's inline style attributes. **Still required:** validate in staging with Google/Plaid flows, add deliberate violation collection if desired, then refine and enforce a tested CSP; consider COOP/CORP where compatible.

### 7. CI does not prove production is healthy
**Evidence:** CI performs install, audit, Node tests, Vite build, Chromium E2E against mocked synthetic API responses, and Docker build. It does not verify IONOS reverse proxy rules, SMTP delivery, external provider webhooks, or a staging restore drill.

**Status: PARTIAL FIX COMMITTED; CI PASSED.** The credential-free CI workflow can be manually dispatched. The deployment checker detects failed assets, incorrect JavaScript/CSS content types, and same-origin CORS rejection for assets and `/api/health`; it reproduces the current live CORS failure. Playwright Chromium tests verify built asset status/MIME types, the signup screen/splash, mocked login-to-dashboard initialization, and generic password recovery. **Still required:** configure the exact production allowlist, run the checker after the change, and verify provider flows and cache headers in staging. Never expose live provider secrets to untrusted PR jobs.

### 8. Backup scripts are not a backup service
**Evidence:** npm run backup creates an encrypted backup file but does not schedule it, transfer backups off-host, enforce retention, alert on failure/staleness, or prove a restore against the deployed volume.

**Fix:** schedule backups outside the API process, store encrypted copies in a separate account/location, separate backup keys from database/provider keys, monitor failures and disk use, define retention/RPO/RTO, and run/record a staging restore drill. Test crash/partial-write behavior and file permissions.

### 9. Plaid polling is an in-process timer, not a durable job system
**Evidence:** a 15-minute timer in server/index.js enumerates connected Items and starts sync jobs. The production runbook notes downtime pauses syncing.

**Failure mode:** sync pauses during restarts; large user counts create bursts; process crashes lose scheduling state; provider rate limits/transient errors can leave data stale without alerting.

**Fix:** before promising timely bank data, use a durable worker/scheduler or provider webhooks plus reconciled periodic jobs; bound concurrency, add backoff/jitter and stale-sync alerts, and expose last-success/error status.

### 10. Database migration management
**Evidence:** the previous startup path ran schema changes directly and had no migration history.

**Status: BASELINE MIGRATION FRAMEWORK IMPLEMENTED; CI PASSED.** `server/migrations.js` records ordered schema versions and applies the existing baseline/legacy upgrades in one SQLite transaction. Regression tests cover upgrading a legacy schema while preserving synthetic user data, idempotent restart, and refusing a newer schema version; these passed in CI run #264. This framework does not define destructive down migrations; rollback must use the documented backup/restore process. Test it against a production-like sanitized copy and ensure only one app instance runs migrations before release.

### 11. Deployment settings and filesystem protections need verification
**Evidence:** SQLite is single-instance; database path is environment-defined; reverse-proxy trust is configurable. Repository review cannot verify actual IONOS permissions, durable storage, firewall, DNS, TLS, or publish directory.

**Fix:** retain AlmaLinux 9, secure database/backup directories and secrets, bind the app only to loopback behind HTTPS proxy, set TRUST_PROXY_HOPS only to the verified proxy chain, keep port 4000 private, verify data survives container replacement/reboot, and document rollback. Do not change live permissions/DNS by guesswork.

### 12. Documentation has drifted from the implementation
**Evidence:** this audit previously claimed README-PRODUCTION.md described email verification/password recovery as unimplemented. A current repository search found that the README correctly describes those flows as implemented and distinguishes code from staging verification. That part of the finding was stale. The broader configuration and release checklists still require owner decisions and live verification, but no specific email-recovery documentation mismatch is confirmed.

**Action:** continue reconciling claims against code, CI, staging evidence, and production evidence separately; remove stale claims when found. Do not treat this corrected email-recovery item as a remaining blocker.

## P3 — product/data quality and resilience

### 13. Validate financial/date fields consistently
**Evidence:** create routes sanitize strings but have inconsistent length bounds, enum validation, and date validation. Goals accept sanitized date/contribution strings without validating date format; task title/category/due strings lack maximum lengths; bill/income/subscription routes need consistent enum/range validation.

**Status: PARTIAL FIX IMPLEMENTED IN DRAFT PR #10; CI PASSED.** Shared validators now enforce at most two decimal places, maximum values, calendar dates, frequency/status enums, and boolean types on account, goal, bill, income, and subscription creation. The bill/income/subscription forms use constrained frequency and date inputs. API regressions and frontend type/build checks passed in CI run #264. Most amount columns use SQLite `INTEGER` affinity, while account balances use `REAL`; API values use JavaScript `Number` in dollar units, and SQLite can store non-integral values in an INTEGER-affinity column. The schema does not enforce integer minor units, so decimal representation/rounding policy and financial domain rules remain open.

### 14. Finance calculations need explicit domain rules and tests
**Evidence:** dashboard safeToSpend/projectedBalance use profile arithmetic; manually entered transactions update current_money, while Plaid imports store transaction rows and connected-account balances separately. This may be intentional but the source-of-truth distinction needs tests.

**Fix:** define whether profile cash is independent from connected account balances, how transfers/refunds/pending transactions are treated, and whether imported transactions affect forecasts. Test income/expense signs, transfers, pending-to-posted replacement, duplicate syncs, timezone/month boundaries, and stale balances. Prevent double-counting imported data and manually entered totals.

### 15. Observability and support runbooks must be exercised
**Evidence:** code logs some provider/SMTP failures, but repository checks do not prove alert routing, request correlation, incident response, or deployed log redaction.

**Status: PARTIAL CODE FIX IMPLEMENTED; CI PASSED.** Provider and server error logs now emit only an allowlisted stable error code or `UnknownError`, never arbitrary message/code/name strings that could contain personal/provider response data or secrets. `server/safe-logging.js` has regression tests including secret-shaped values. Request IDs, alert routing, stale-sync/backup/disk monitors, and an assigned incident responder still need implementation and operational proof.

## Items requiring live/staging access

These cannot be conclusively determined from source alone:
- Whether public HTML references built assets or the Vite source entry.
- Whether the exact-origin production CORS allowlist repair has been applied and the app loads successfully in a real browser.
- Live container image/build identity, durable volume, and actual Caddy configuration (public Caddy-to-Express routing is confirmed from response headers, but Docker inspection was denied).
- DNS, certificate chain, TLS, firewall, SSH, and actual volume persistence.
- SMTP deliverability/domain authentication, Stripe test checkout/webhook lifecycle, Plaid Sandbox/OAuth redirect behavior.
- Off-host backup upload, key recovery, restore time, and deletion propagation through backups/providers.
- Accessibility, responsive behavior, browser-specific issues, and real-device performance.

## Release checklist

### Implemented in draft PR #10; CI evidence is recorded above
- Fail-closed `NODE_ENV`/`APP_ENV` consistency validation.
- Canonical HTTPS origin parsing and startup check that the `APP_BASE_URL` origin is present in `ALLOWED_ORIGINS`.
- Resumable Plaid transaction pagination with cursor persistence, replay, partial-failure, and database-reopen tests.
- Production HttpOnly cookie sessions, CSRF proof, logout/reset revocation, and SQLite-backed single-instance rate limits.
- Route validation improvements, Stripe webhook idempotency/order protection, versioned baseline migrations, safe error logging, and same-origin deployment checks.

### Remaining release blockers and owner/environment actions
1. Resolve the live Origin-dependent 403 by inspecting actual host configuration and adding the exact supported site origins; verify the page, every asset, API health, and a real browser after a controlled service restart.
2. Validate staging with synthetic users and provider test modes, including browser login/recovery/dashboard, Google/Plaid compatibility, Stripe checkout/webhook/cancellation, and SMTP delivery.
3. Complete a sanitized production-like migration upgrade and a scheduled encrypted off-host backup/restore drill; verify retention, alerts, RPO/RTO, and rollback.
4. Decide financial source-of-truth rules, money precision migration, transfer/refund/pending semantics, and bank-balance freshness; add calculation tests after the rules are agreed.
5. Browser E2E tests for built asset MIME/status, signup screen/splash, login/dashboard initialization, and generic password recovery passed in CI run #264 on code head `1a5e402d162ba2ef7d676cf0d0cf7e545616084e`. Staging provider flows, accessibility, responsive behavior, and real-device checks remain open.
6. Complete independent security review and qualified legal/privacy review; finalize support, deletion/retention, and incident-response ownership.
7. Keep PR #10 and PR #1 unmerged and production unchanged until the release gates have evidence and the release owner approves deployment.
