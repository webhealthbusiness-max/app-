# Grounded API route access matrix

Review basis: `server/index.js` on the `ci-smoke-tests` branch, current automated tests, and source inspection. This is an implementation review, not a penetration test or external security certification. Route owners should update this matrix whenever a route is added or its authorization logic changes.

## Public routes (no user bearer token by design)

| Route | Intended access / control |
| --- | --- |
| `POST /api/auth/signup` | Public; rate-limited; validates inputs; production requires email verification. |
| `POST /api/auth/verify-email` | Public; accepts only a hashed, unexpired verification token; token is single-use. |
| `POST /api/auth/resend-verification` | Public; rate-limited; generic response avoids revealing account existence. |
| `POST /api/auth/password-reset/request` | Public; rate-limited; generic response avoids revealing account existence. |
| `POST /api/auth/password-reset/complete` | Public; requires an unexpired single-use reset token and password validation; increments session version to revoke existing bearer sessions. |
| `POST /api/auth/login` | Public; rate-limited; checks password and email verification in production. |
| `POST /api/auth/google` | Public; rate-limited; verifies Google ID token against configured audience and requires Google's verified-email claim. |
| `POST /api/billing/webhook` | Public provider callback; validates Stripe signature against the exact raw body and checks billing identifiers for cross-user conflicts before persistence. |
| `GET /privacy`, `GET /terms`, `GET /copyright` | Public static legal pages; content still needs legal review. |
| `GET /health`, `GET /api/health` | Public health checks; do not include credentials or financial records in output. |

## Authenticated routes

These routes must use `withUser`; the authenticated user ID is derived from the verified bearer token, never from a client-supplied user ID.

| Route group | Routes | Required authorization |
| --- | --- | --- |
| Profile / identity | `GET /api/me`, `POST /api/profile` | Read/update only the authenticated user's profile. |
| Dashboard / export / deletion | `GET /api/dashboard`, `GET /api/data/export`, `DELETE /api/data/delete` | All selected data scoped to the current user; deletion revokes provider connections before deleting local data and removes pending auth tokens. |
| Banking | `GET /api/banking/status`, `POST /api/banking/link-token`, `POST /api/banking/exchange`, `POST /api/banking/sync`, `DELETE /api/banking/connections/:itemId` | Every bank Item/account/transaction operation must be scoped to the authenticated user. Access tokens are encrypted at rest. Plaid is disabled unless all required settings are configured. |
| Accounts | `POST /api/accounts` | New records must use `req.user.id`; never accept a client-provided owner ID. |
| Notifications | `GET /api/notifications`, `POST /api/notifications/:id/read`, `POST /api/notifications/read-all` | Read/update only the current user's notifications; mark-read mutation includes both notification ID and user ID. |
| Billing | `GET /api/billing/status`, `POST /api/billing/checkout`, `POST /api/billing/portal` | Stripe customer/subscription IDs come from server-side billing records for the current user. Do not trust IDs supplied by the browser. |
| Premium insights | `GET /api/premium/insights` | Authenticated and server-side subscription entitlement checked by `requirePlus`; all queries scoped to the user. |
| Tasks | `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/:id/toggle` | Reads are user-scoped; creates assign the authenticated owner; toggle update uses both task ID and user ID in the write query. |
| Goals | `GET /api/goals`, `POST /api/goals` | User-scoped reads and owner assignment on create; subscription limits enforced server-side. |
| Transactions | `GET /api/transactions`, `POST /api/transactions` | User-scoped reads and authenticated owner assignment on create. |
| Bills | `GET /api/bills`, `POST /api/bills` | User-scoped reads and authenticated owner assignment on create. |
| Income | `GET /api/income`, `POST /api/income` | User-scoped reads and authenticated owner assignment on create. |
| Manual subscriptions | `GET /api/subscriptions`, `POST /api/subscriptions` | User-scoped reads and authenticated owner assignment on create. |

## Findings and remaining work

- Fixed earlier: task completion mutation must include both task ID and authenticated user ID in the SQL update.
- Fixed earlier: Stripe subscription persistence rejects Stripe customer/subscription identifiers already linked to a different Grounded user.
- Implemented on this branch: expiring, hashed, single-use email-verification and password-reset tokens; production login blocks unverified email/password accounts; password reset increments session version; auth tokens are removed during account deletion.
- Implemented on this branch: encrypted SQLite backup and non-destructive restore utilities, with a synthetic-database CI round-trip test.
- Existing integration coverage exercises authentication, data export/deletion, user-separated dashboard data, billing webhooks, and provider-disabled behavior. Source-level tests check the task and Stripe ownership guards.
- Remaining validation: add/complete cross-user negative tests for every authenticated route class, especially nested bank/account/transaction resources and notification mutations; perform SMTP-backed end-to-end verification/reset tests; run staging tests with synthetic records; and complete a staging restore drill.
- Operational risk: rate limits and scheduled Plaid syncing are process-local, so the current architecture is single-instance only. Keep a single API instance with durable storage until rate limiting, jobs, and database architecture are upgraded.
- Do not accept real financial data until staging evidence, independent security review, backup restore drill, provider approvals, and production deployment gates are complete.
