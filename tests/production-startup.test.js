import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const serverPath = fileURLToPath(new URL('../server/index.js', import.meta.url))
const productionConfigKeys = [
  'APP_ENV',
  'JWT_SECRET',
  'ALLOWED_ORIGINS',
  'DATABASE_PATH',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_MONTHLY',
  'STRIPE_PRICE_ANNUAL',
  'APP_BASE_URL',
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'SMTP_PORT',
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'BANK_TOKEN_ENCRYPTION_KEY',
  'PLAID_ENV',
  'PLAID_REDIRECT_URI',
]

function runWithProductionEnv(overrides = {}) {
  const env = { ...process.env, NODE_ENV: 'production' }
  for (const key of productionConfigKeys) delete env[key]
  Object.assign(env, overrides)

  return spawnSync(process.execPath, [serverPath], {
    cwd: path.dirname(path.dirname(serverPath)),
    env,
    encoding: 'utf8',
    timeout: 10_000,
  })
}

test('production startup fails closed when JWT_SECRET is missing', () => {
  const result = runWithProductionEnv()
  assert.notEqual(result.status, 0, 'server must not start without a production JWT secret')
  assert.match(result.stderr, /JWT_SECRET of at least 32 characters/)
})

test('production startup requires an explicit CORS allowlist', () => {
  const result = runWithProductionEnv({ JWT_SECRET: 'x'.repeat(48) })
  assert.notEqual(result.status, 0, 'server must not start without an explicit origin allowlist')
  assert.match(result.stderr, /ALLOWED_ORIGINS must be explicitly configured/)
})

test('production startup requires a durable database path', () => {
  const result = runWithProductionEnv({
    JWT_SECRET: 'x'.repeat(48),
    ALLOWED_ORIGINS: 'https://grounded.example',
  })
  assert.notEqual(result.status, 0, 'server must not start without a configured persistent database path')
  assert.match(result.stderr, /DATABASE_PATH must point to a persistent production data volume/)
})

test('production-hardening staging mode explicitly requires test providers while live mode requires live providers', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(serverPath, 'utf8')
  assert.ok(source.includes("if (isProduction && appEnvironment === 'staging' && !process.env.STRIPE_SECRET_KEY.startsWith('sk_test_'))"))
  assert.ok(source.includes("if (isProduction && appEnvironment === 'production' && !process.env.STRIPE_SECRET_KEY.startsWith('sk_live_'))"))
  assert.ok(source.includes("Staging bank connections must use PLAID_ENV=sandbox."))
  assert.ok(source.includes("Production bank connections must use PLAID_ENV=production."))
})

test('account deletion sends its receipt after cleanup rather than queueing a doomed email', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(serverPath, 'utf8')
  const deletionStart = source.indexOf("app.delete('/api/data/delete'")
  assert.notEqual(deletionStart, -1, 'account deletion route must exist')
  const deletionEnd = source.indexOf('\napp.', deletionStart + 1)
  const deletionRoute = source.slice(deletionStart, deletionEnd === -1 ? source.length : deletionEnd)
  assert.match(deletionRoute, /'notification_emails'/, 'account deletion must remove queued email records')
  assert.match(deletionRoute, /const deletionEmail = \{[\s\S]*to: req\.user\.email/, 'deletion receipt must preserve the account email before deleting the user')
  assert.doesNotMatch(deletionRoute, /notifyUser\(/, 'do not queue a notification that cleanup immediately deletes')
  assert.ok(deletionRoute.indexOf('await emailTransport.sendMail') > deletionRoute.indexOf('db.transaction'), 'send the receipt only after account deletion succeeds')
})
test('email worker does not send a queue item that was deleted before it was claimed', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(serverPath, 'utf8')
  assert.match(source, /const claim = db\.prepare\('UPDATE notification_emails SET status = \? WHERE id = \? AND status = \?'\)[\s\S]{0,120}if \(!claim\.changes\) continue/)
})

test('task completion update enforces ownership in the write query', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(serverPath, 'utf8')
  const routeStart = source.indexOf("app.patch('/api/tasks/:id/toggle'")
  assert.notEqual(routeStart, -1, 'task toggle route must exist')
  const routeEnd = source.indexOf('\napp.', routeStart + 1)
  const route = source.slice(routeStart, routeEnd === -1 ? source.length : routeEnd)
  assert.match(route, /UPDATE tasks SET completed = \? WHERE id = \? AND user_id = \?/, 'task update must be scoped to the authenticated owner')
})


test('Stripe subscription persistence rejects billing identifiers owned by another user', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(serverPath, 'utf8')
  const persistenceStart = source.indexOf('const persistStripeSubscription =')
  assert.notEqual(persistenceStart, -1, 'Stripe persistence function must exist')
  const persistenceEnd = source.indexOf('\nconst getBillingStatus', persistenceStart)
  const persistence = source.slice(persistenceStart, persistenceEnd === -1 ? source.length : persistenceEnd)
  assert.match(persistence, /WHERE \(stripe_customer_id = \? AND \? IS NOT NULL\)[\s\S]*OR \(stripe_subscription_id = \? AND \? IS NOT NULL\)/, 'existing Stripe identifiers must be checked')
  assert.match(persistence, /conflictingBillingRecords\.some\(\(record\) => record\.user_id !== userId\)/, 'billing records must not be reassigned across users')
  assert.ok(persistence.indexOf('conflictingBillingRecords.some') < persistence.indexOf('INSERT INTO billing_subscriptions'), 'ownership conflict must be checked before persistence')
})


test('email verification and password recovery use expiring single-use hashed tokens and revoke sessions on reset', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(serverPath, 'utf8')
  assert.match(source, /CREATE TABLE IF NOT EXISTS auth_tokens/)
  assert.match(source, /createHash\('sha256'\)\.update\(token\)\.digest\('hex'\)/)
  assert.ok(source.includes("app.post('/api/auth/verify-email'"))
  assert.ok(source.includes("app.post('/api/auth/password-reset/request'"))
  assert.ok(source.includes("app.post('/api/auth/password-reset/complete'"))
  assert.match(source, /expires_at > CURRENT_TIMESTAMP/)
  assert.match(source, /session_version = session_version \+ 1/)
  assert.match(source, /requireEmailVerification && !user\.email_verified/)
})

test('staging and production APP_ENV values require NODE_ENV=production', () => {
  const result = runWithProductionEnv({ NODE_ENV: 'development', APP_ENV: 'production' })
  assert.notEqual(result.status, 0, 'production APP_ENV must not run with development NODE_ENV')
  assert.match(result.stderr, /APP_ENV=staging or production requires NODE_ENV=production/)
})

test('Plaid sync persists the latest processed cursor when more pages remain', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(serverPath, 'utf8')
  const syncStart = source.indexOf('const syncPlaidConnection =')
  const syncEnd = source.indexOf('\nconst bankSyncTimer', syncStart)
  assert.notEqual(syncStart, -1, 'Plaid sync function must exist')
  const sync = source.slice(syncStart, syncEnd)
  assert.match(sync, /while \(hasMore && pageCount < 10\)/, 'sync must bound one run')
  assert.match(sync, /\.run\(cursor, connection\.item_id, connection\.user_id\)/, 'sync must save the latest processed cursor even when another batch remains')
  assert.doesNotMatch(sync, /\.run\(hasMore \? connection\.cursor : cursor/, 'sync must not retain the old cursor when more pages remain')
})
