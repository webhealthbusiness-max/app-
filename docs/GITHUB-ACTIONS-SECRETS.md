# Grounded GitHub Actions Secrets Setup

The public Grounded site is live, but no evidence here shows that GitHub Actions deploys it or that production uses this repository's current branch. The current workflow is CI-only (install, audit, tests, build, and container build) and should not need Plaid or Stripe credentials. Do not add live provider secrets to pull-request workflows.

## Security rules

- Never commit .env files, API keys, webhook signing secrets, encryption keys, or real user data.
- Never paste credentials into issues, pull requests, chat, workflow YAML, command-line arguments, or logs.
- Do not pass financial-provider secrets to ordinary pull_request test/build jobs. A test/build job should run without credentials.
- Do not use pull_request_target to check out and execute untrusted pull-request code with secrets.
- Use separate credentials and separate GitHub Environments for staging and production. Never reuse test credentials in production or live credentials in staging.
- GitHub Actions secrets do not configure a deployed API. When a hosting provider is chosen, add the corresponding values to that provider's server-side secret manager too. Never put private API secrets in VITE_ frontend variables.
- Environment secrets are available only to jobs that explicitly reference that environment. GitHub encrypts secrets, but masking is not a substitute for keeping them out of logs.

## 1. Create GitHub Environments

Open Settings → Environments:
https://github.com/webhealthbusiness-max/app-/settings/environments

Create these exact environments:

- staging: synthetic/test data only; Plaid Sandbox and Stripe test mode.
- production: live services only; keep empty until production readiness and Plaid approval are complete.

If your repository and plan support deployment protection rules, restrict staging to the intended staging branch and production to the release branch/tags. Require approval for production jobs where available. Do not create a deployment workflow yet.

## 2. Add staging environment secrets

Open Settings → Environments → staging → Add secret. Add values directly in GitHub's secret form; do not put the values into a repository file.

| Secret name | Value to store |
| --- | --- |
| PLAID_CLIENT_ID | Plaid application client ID for Sandbox |
| PLAID_SECRET | Plaid Sandbox secret |
| BANK_TOKEN_ENCRYPTION_KEY | Dedicated random 32-byte key encoded as exactly 64 hexadecimal characters |
| STRIPE_SECRET_KEY | Stripe test-mode secret key, usually begins sk_test_ |
| STRIPE_WEBHOOK_SECRET | Signing secret from a Stripe test-mode webhook endpoint |
| STRIPE_PRICE_MONTHLY | Test-mode Price ID for the monthly subscription |
| STRIPE_PRICE_ANNUAL | Test-mode Price ID for the annual subscription |

Add non-secret environment variables in the same environment only if a future staging integration workflow needs them:

- PLAID_ENV=sandbox
- NODE_ENV=development (do not set production here)
- APP_BASE_URL: staging URL only after one exists
- ALLOWED_ORIGINS: exact staging frontend origin only after one exists

Generate a new encryption key locally, without sharing it:

    openssl rand -hex 32

Copy the generated value directly into GitHub's secret form. Keep a secure backup; losing this key can make encrypted Plaid access tokens unusable. Do not use the same encryption key in staging and production.

Stripe Price IDs must belong to the same Stripe mode as the secret key. Never mix test keys with live Price IDs.

## 3. Production secrets — defer until approved and ready

Open Settings → Environments → production. Do not add production credentials until the production service exists, test coverage is complete, and the relevant provider approvals are in place.

| Secret name | Value to store |
| --- | --- |
| PLAID_CLIENT_ID | Plaid application client ID |
| PLAID_SECRET | Plaid Production secret, only after Plaid approval |
| BANK_TOKEN_ENCRYPTION_KEY | A different, securely backed-up 32-byte key encoded as 64 hexadecimal characters |
| STRIPE_SECRET_KEY | Stripe live secret key, usually begins sk_live_ |
| STRIPE_WEBHOOK_SECRET | Signing secret for the live webhook endpoint |
| STRIPE_PRICE_MONTHLY | Live monthly recurring Price ID |
| STRIPE_PRICE_ANNUAL | Live annual recurring Price ID |

Future API hosting will also need server-side values such as JWT_SECRET, DATABASE_PATH, APP_BASE_URL, ALLOWED_ORIGINS, and required SMTP settings. These are runtime settings, not credentials that need to be added to the ordinary CI workflow. Keep live values out of staging and test jobs.

Set the non-secret production variable PLAID_ENV=production only after Plaid Production access is approved. Do not set PLAID_ENV=production in staging.

## 4. Keep ordinary CI credential-free

The current CI pipeline should run these checks without Plaid/Stripe secrets:

    npm ci
    npm audit --audit-level=moderate
    npm test
    npm run build

Do not add secrets to a job's env unless a specific test truly requires them. If integration tests are later added, create a separate job that explicitly references environment: staging, uses only synthetic data, and has the minimum permissions needed. Never let a pull-request workflow access the production environment.

Do not add an integration workflow until an integration test command exists and its behavior has been reviewed. Avoid logging environment variables or provider payloads.

## 5. Verify configuration without exposing values

- In GitHub's Environment settings, confirm the expected secret names exist in staging; GitHub will not reveal saved secret values.
- Keep production empty until it is actually needed.
- Run the existing CI workflow and confirm install, audit, tests, and build pass without provider secrets.
- Never echo secrets for debugging. If a key is accidentally committed or printed, revoke/rotate it at the provider immediately, then remove it from active configuration and review logs/history.
- Do not store actual credentials in this checklist or in Git.

## 6. Important current limitation

This configures secret storage for GitHub Actions only. It does not deploy Grounded, set operating-system environment variables, create Stripe products/prices or webhook endpoints, or enable Plaid. GitHub repository/environment secrets are not automatically injected into the running app. Once a host is selected, configure its server-side secret manager separately and follow README-PRODUCTION.md before accepting real financial data.
