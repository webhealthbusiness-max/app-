# Grounded financial-data access-control review

This is a launch-blocker review checklist, not a claim of independent penetration testing. Complete the checks against the release candidate and record evidence before accepting real financial data.

## Existing protections observed in the API

- Private API routes use `withUser`; production identity comes from a verified HttpOnly session cookie, while bearer-token compatibility is restricted to non-production.
- Core finance records are associated with a user ID; read/write queries should include the authenticated user's ID.
- API responses use `Cache-Control: no-store` and security headers.
- Plaid access tokens are encrypted at rest using AES-256-GCM and a separately configured key.
- Stripe webhook requests use signature verification; billing persistence includes ownership conflict checks.
- Account deletion attempts provider-side Plaid revocation before deleting local records.

## Mandatory route-by-route review

For every endpoint that reads, creates, changes, exports, syncs, or deletes data, record: route, HTTP method, authentication, authorization predicate, validation, sensitive fields returned, rate limit, and test ID.

- [ ] Profile, dashboard, goals, tasks, transactions, bills, incomes, subscriptions, accounts, and notifications are scoped to the authenticated user.
- [ ] Updates and deletes include both resource ID and user ID in the SQL mutation—not only in a preceding SELECT.
- [ ] Nested resources (transactions by account, Plaid Item, billing subscription, notification, and uploaded/exported data) cannot be reached by guessing another user's ID.
- [ ] Bank Link token creation, public-token exchange, sync, disconnect, and Item deletion enforce ownership for every request.
- [ ] Plaid access tokens, public tokens, full bank payloads, account numbers, and sensitive finance data never appear in logs, API errors, analytics, URLs, or frontend bundles.
- [ ] Stripe checkout/portal routes derive the customer and subscription from the authenticated user's server-side billing record; user-supplied customer IDs are not trusted.
- [x] Stripe webhook signature verification uses the exact raw request body and rejects missing/invalid signatures; event IDs are recorded for replay deduplication, and subscription events with older provider timestamps are ignored.
- [ ] Export and account deletion cover all relevant data tables, queued emails, tokens, provider connections, and documented retention/backups.
- [ ] Authentication routes have bounded input sizes, rate limits, generic responses for recovery requests, expiring one-time tokens, and no user-enumeration side channel.
- [ ] CORS allows only explicit trusted origins; proxy trust is limited to known infrastructure; authenticated responses are not cached by CDN.
- [ ] SQL statements are parameterized and migrations are tested against both fresh and existing databases.
- [ ] CI tests attempt cross-user access for every route class and test direct mutation attacks, not just read access.
- [ ] Frontend state and hidden UI are not treated as authorization; server checks are authoritative.

## Test plan required before launch

Create at least two synthetic users, Alice and Bob. Seed each with unique account, transaction, bill, income, goal, task, notification, and bank-connection records. For each endpoint, try Bob's token against Alice's resource IDs and verify no information is returned or changed. Include sequential IDs, malformed IDs, missing ownership links, expired/revoked tokens, duplicate provider identifiers, and concurrent requests.

- [ ] Negative tests assert 401/403/404 as appropriate and confirm database rows are unchanged after failed requests.
- [ ] Test financial-data export and deletion for both accounts and provider-related rows.
- [ ] Test billing webhook replay and identifier conflicts.
- [ ] Test Plaid token encryption/decryption, wrong-key failure, disconnect and deletion behavior.
- [ ] Review logs and HTTP responses after tests for secrets and personal data.
- [ ] Have a qualified security reviewer assess the final route inventory and test evidence.

## Known architecture limits

SQLite-backed rate limits and the app database are single-host/single-instance oriented. Production sessions now use HttpOnly/Secure/SameSite cookies with HMAC-backed CSRF proof; the short-lived bearer compatibility path is restricted to non-production. The app still needs proof of durable storage, encrypted off-host backup scheduling, a completed restore drill, staging validation of email verification/password recovery and Google/Plaid flows, trusted proxy configuration, and an independent security review before launch. This checklist does not substitute for legal, privacy, compliance, or independent security review.
