# Grounded production audit findings

**Scope:** static review of the ci-smoke-tests branch. This is not a penetration test, a verified live-site probe, or a legal/compliance opinion. Code-backed findings are distinguished from operational items that require staging or host access.

## Release recommendation

**Do not accept real financial data or enable Plaid/Stripe live mode yet.** Keep PR #1 unmerged until high-priority code and operational blockers are addressed, tests pass, and staging is exercised.

## P1 — fix before production

### 1. Production hardening depends on NODE_ENV, not APP_ENV alone
**Evidence:** server/index.js derives isProduction only from NODE_ENV === 'production', while APP_ENV independently accepts staging or production. JWT fallback, email-verification enforcement, provider-mode checks, and required production settings depend on isProduction.

**Failure mode:** if a host is misconfigured with APP_ENV=production but NODE_ENV is missing/incorrect, startup guards can be skipped and the development JWT fallback can be used. This is a fail-open configuration path even though the documented Dockerfile sets both values.

**Fix:** reject inconsistent combinations at startup; require NODE_ENV=production whenever APP_ENV is staging or production; never permit the development JWT fallback outside explicit development/test; add startup tests for every invalid combination.

### 2. Plaid sync can get stuck after more than 5,000 changes
**Evidence:** syncPlaidConnection in server/index.js stops after 10 pages of 500 transactions. When hasMore remains true, it stores the original connection.cursor instead of the last processed cursor.

**Failure mode:** the next sync starts from the same old cursor and can repeat the first 5,000 changes indefinitely, so later transaction changes may never arrive. The endpoint reports complete:false but has no durable continuation mechanism for the next batch.

**Fix:** persist a safe continuation cursor/checkpoint and resume from it, or process all pages with a bounded time/page policy that resumes safely. Define crash/retry semantics for page changes and cursor commits. Add a deterministic test with more than 10 pages and prove the final cursor advances and every added/modified/removed transaction is reflected correctly after retries/restarts.

### 3. Browser bearer token is stored in localStorage
**Evidence:** src/App.tsx reads/writes grounded-token in localStorage; that JWT authorizes finance-data API requests.

**Failure mode:** successful script injection or a compromised third-party script can read and exfiltrate a reusable bearer token. The app loads Google/Plaid browser scripts and currently does not set a Content-Security-Policy response header.

**Fix:** review a migration to Secure, HttpOnly, SameSite cookies with CSRF protection and session rotation/revocation, or explicitly document why bearer tokens are retained and implement a strict XSS defense strategy. Add a carefully tested CSP compatible with Vite, Google Identity Services, Plaid Link, fonts, and API origins. Avoid unsafe-inline/eval unless justified. Audit user-text rendering and add browser security tests. Do not blindly switch to cookies without CSRF design.

### 4. In-memory rate limits are not a production abuse-control system
**Evidence:** requestBuckets is a process-local Map; authentication/recovery limits are keyed by client IP. The production runbook itself notes these limits do not coordinate across processes or survive restarts.

**Failure mode:** restarts/replicas bypass limits; distributed attackers can spray password-reset/verification emails; users behind one shared IP can block each other; stale map entries are cleaned only when the map reaches its bucket cap.

**Fix:** use shared storage; for one host a durable database may be sufficient, while scaling usually needs Redis/equivalent. Combine IP/network and normalized account/email keys without revealing account existence, bound key cardinality, set route-specific limits for signup/login/Google/recovery/bank sync/checkout/portal, and test proxy IP handling and 429 behavior.

### 5. Production privacy/legal documents are not ready
**Evidence:** server/index.js labels the privacy page a pre-launch disclosure and says production retention, backup-erasure policy, and independent privacy review are missing. Terms are explicitly drafts. README-PRODUCTION.md lists counsel review and retention/deletion review as outstanding.

**Failure mode:** users may rely on incomplete or inaccurate disclosures about financial data, providers, retention, account deletion, subscription renewal, and support.

**Fix:** qualified review and finalization of privacy policy, terms, pricing/renewal/refund disclosures, data inventory, retention/deletion policy, support and incident contacts before launch. Verify actual behavior matches final disclosures. This is not solved by a code patch.

## P2 — resolve before public launch

### 6. Browser security policy and hardening validation are incomplete
**Evidence:** server sets nosniff, frame denial, referrer policy, permissions policy, and HSTS in production, but no CSP. The reviewed CI configuration has no browser end-to-end tests.

**Fix:** design CSP from actual dependencies, consider COOP/CORP where compatible, validate HTTPS/TLS and headers against the deployed origin, and add browser E2E tests for sign-in, app startup, navigation, OAuth/Plaid redirects, and failed asset handling.

### 7. CI does not prove production is healthy
**Evidence:** CI performs install, audit, Node tests, Vite build, and Docker build. It does not verify IONOS reverse proxy rules, SMTP delivery, external provider webhooks, or a staging restore drill.

**Fix:** keep CI credential-free; add a staging-only smoke/E2E workflow using synthetic data and test credentials. Add post-deploy checks for built HTML, same-origin hashed assets, /api/health, auth flows, and cache headers. Never expose live provider secrets to untrusted PR jobs.

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

**Fix:** centralize request schemas for every API route; cap text/array sizes; validate real calendar dates, frequency/status/type enums, numeric precision/ranges; use integer minor units for money or explicitly test decimal storage/rounding. Add malformed, oversized, negative, and boundary tests.

### 14. Finance calculations need explicit domain rules and tests
**Evidence:** dashboard safeToSpend/projectedBalance use profile arithmetic; manually entered transactions update current_money, while Plaid imports store transaction rows and connected-account balances separately. This may be intentional but the source-of-truth distinction needs tests.

**Fix:** define whether profile cash is independent from connected account balances, how transfers/refunds/pending transactions are treated, and whether imported transactions affect forecasts. Test income/expense signs, transfers, pending-to-posted replacement, duplicate syncs, timezone/month boundaries, and stale balances. Prevent double-counting imported data and manually entered totals.

### 15. Observability and support runbooks must be exercised
**Evidence:** code logs some provider/SMTP failures, but repository checks do not prove alert routing, request correlation, incident response, or deployed log redaction.

**Fix:** add request IDs and safe error classification; monitor auth abuse, 5xx, SMTP queue growth, stale Plaid syncs, backup age/failure, disk exhaustion, and Stripe webhook failures. Ensure logs exclude tokens, passwords, raw bank payloads, and unnecessary personal/financial data; assign a human response owner.

## Items requiring live/staging access

These cannot be conclusively determined from source alone:
- Whether public HTML references built assets or the Vite source entry.
- Exact status of each production JS/CSS asset and whether IONOS permissions/rewrite/proxy rules cause the reported loading failure.
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
