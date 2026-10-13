# Grounded

Grounded is a personal finance and life organization app focused on "safe to spend" and financial clarity.

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

This runs:
- the Vite frontend on http://localhost:3000 (Vite selects the next free port if needed)
- the Grounded API server on http://localhost:4000

## Mobile launch screen

Grounded shows a branded launch screen while the app starts and verifies a saved session. The web app manifest and 180, 192, and 512 pixel icons provide matching browser/app-launch branding on supported mobile devices. The launch screen and manifest are included in the Vite `dist/` build.

## API auth flow

- Sign up with email/password
- Login with the same credentials
- Optional Google sign-in using a verified Google Identity Services ID token
- All protected routes use a bearer token from the login response

## Account notifications and email

Grounded adds in-app notifications and queues email alerts for account creation, password/Google sign-ins, manual financial-account additions, account deletion, and subscription status changes. Notification records are removed when an account is deleted. Pending email delivery records temporarily contain the recipient address and are removed after delivery or after the final retry.

To send email through Gmail, enable 2-Step Verification on the sending Google account and create a Google App Password. Put the Gmail address in `SMTP_USER` and the App Password in `SMTP_PASS`; never use your regular Gmail password. Set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, and `SMTP_FROM` to the sender address. A different SMTP provider can be used with its own host, port, credentials, and sender. Production startup requires SMTP configuration; without SMTP in local development, in-app notifications continue to work and the app labels email alerts as unavailable.

To enable Google sign-in, create a Google OAuth **Web application** client ID, add the app's deployed origin to its authorized JavaScript origins, then set that same client ID as both `GOOGLE_CLIENT_ID` and `VITE_GOOGLE_CLIENT_ID`. Restart both the server and Vite after changing these settings. Google email must be verified; passwords for Google-only accounts are random and are never sent to or stored by Google.

The Money screen supports manual entries and an optional **US Plaid Transactions** connection. With Plaid credentials configured, a user must explicitly consent, then selects accounts inside Plaid Link. Grounded stores Plaid access tokens encrypted with AES-256-GCM; it never asks for or stores bank passwords. Imported balances and categorized transactions sync at connection time, on demand, and approximately every 15 minutes while the API process is running. Institutions control how quickly fresh data becomes available.

To try bank linking, create a Plaid Sandbox application and set `PLAID_CLIENT_ID`, `PLAID_SECRET`, and a stable `BANK_TOKEN_ENCRYPTION_KEY` (generate one with `openssl rand -hex 32`). Set `PLAID_ENV=sandbox`; use Plaid's test institutions and test data only. For real accounts, Plaid must approve the application and requested products, and you must set production credentials and `PLAID_ENV=production`. Keep the encryption key in the same production secret manager as the other secrets and back it up securely: losing it makes connected Items unusable. If using OAuth institutions, set `PLAID_REDIRECT_URI` to the exact HTTPS redirect URL registered in the Plaid dashboard and app configuration.

Disconnect removes the provider Item and imported account/transaction records. Account deletion also tries to revoke every connected Item before deleting local data. Configure an independent production database, backups, legal/privacy disclosures, incident handling, and user support before enabling real bank connections. Plaid production access, pricing, geographic eligibility, institutional coverage, and contractual terms are subject to Plaid review.

## Environment and deployment readiness

Copy `.env.example` to `.env` and adjust values for your local environment.

Required settings for a more launch-safe setup:

```bash
PORT=4000
JWT_SECRET=replace-with-a-strong-random-value
RATE_LIMIT_WINDOW_MS=60000
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3003
NODE_ENV=development
```

When `NODE_ENV=production`, the API also requires `JWT_SECRET` to be at least 32 characters, `ALLOWED_ORIGINS` to be explicitly set without localhost origins, `DATABASE_PATH` to point to a configured persistent volume, complete SMTP settings, and Stripe live-mode configuration. Never use the development secret in production.

The current implementation is SQLite-backed and supports a single API instance only. A managed, multi-instance database adapter, backup/restore process, and a production hosting configuration still need to be selected and implemented before production financial data is accepted.

## Monetization

Grounded uses a freemium subscription model:

- **Free:** manual money planning, core dashboard, transactions, bills, subscriptions, export/delete controls, and up to 3 savings goals.
- **Grounded Plus:** unlimited goals and current-month spending-by-category insights based on recorded manual and connected-bank transactions.
- **Price:** $5.99/month or $59.99/year (USD, before applicable taxes).

Checkout, subscription status updates, cancellation management, and billing portal links use Stripe Checkout/Billing Portal. Paid entitlements are only granted by a verified Stripe webhook; redirecting back from checkout alone does not activate Plus.

To test payments, configure a Stripe test account and create two recurring Prices (USD 5.99 monthly and USD 59.99 yearly). Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL`, and `APP_BASE_URL`. Configure a Stripe webhook to POST to `/api/billing/webhook` for `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted`. Enable the Stripe customer portal and verify checkout, renewal, failed payment, cancellation, and webhook retry behavior in test mode before enabling live keys.

The app cannot receive payments until those Stripe account values and webhook have been configured. Keep test keys for development and live keys only in the production secret manager.

## Security hardening included

- JWT auth with protected routes
- request rate limiting on signup/login
- CORS origin restrictions
- JSON size limits and secure response headers
- input validation for finance fields and onboarding data
- health endpoints for service monitoring
- isolated API smoke tests for authentication, account data isolation, validation, export, and deletion
- production startup checks for required secret, origin, and persistent-database configuration
- new accounts start with empty, user-entered financial data rather than fabricated demo balances and transactions
- free/Plus plan status and entitlements are checked server-side
- paid subscription status is synchronized only through signed Stripe webhooks
- persistent in-app notifications and SMTP-backed email alerts for account/security and billing events
- optional Google Identity Services sign-in with server-side ID token verification
- optional Plaid Transactions bank linking, encrypted provider tokens, categorized transaction sync, and user-controlled disconnect

## Validation

```bash
npm test
npm run build
npm audit --audit-level=moderate
```

## Legal and privacy pages

The API includes public informational pages for:

- `/privacy`
- `/terms`
- `/copyright`

These are draft disclosures and must be reviewed by qualified counsel before public release. They are not legal advice or a compliance certification.

## Remaining launch blockers

For the full step-by-step checklist, required production settings, and go-live/rollback sequence, see [README-PRODUCTION.md](./README-PRODUCTION.md).

Do not accept real financial data or describe the app as production-ready until all applicable blockers are addressed:

- Select a hosting provider, domain, TLS setup, secret manager, and persistent database provider; these require account access and deployment decisions.
- Configure Stripe products/prices, live keys, customer portal, webhook, billing support contact, refunds/cancellation terms, and tax handling.
- Obtain Plaid approval for production access and review the bank-data consent, privacy disclosures, retention/deletion behavior, support process, and applicable legal requirements before connecting real financial institutions.
- Replace SQLite with a managed database adapter suitable for production, with encrypted backups, restore drills, migrations, and access controls.
- Replace the in-memory rate limiter with a shared rate-limit store before running multiple instances.
- Add email verification, password reset, and a reviewed session/token storage strategy; decide and implement MFA based on the risk assessment.
- Arrange qualified legal/privacy review of the disclosures, retention/deletion behavior, and applicable financial/privacy regulations.
- Configure production logging, error tracking, alerting, uptime monitoring, incident response, and operational ownership.
- Complete an independent security review and broaden automated tests (including browser end-to-end tests and deployment checks).
- Verify deletion and retention behavior across database files, backups, logs, and any external processors.
- Perform real-device browser QA and accessibility review.

## Notes

The app is an MVP suitable for local evaluation. Automatic bank synchronization requires Plaid production approval and credentials; email verification/password reset, production database hosting, and legal/compliance certification are not implemented. Forecasts are estimates from manually entered profile values and are not financial advice.
