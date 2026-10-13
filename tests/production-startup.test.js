import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const serverPath = fileURLToPath(new URL('../server/index.js', import.meta.url))
const productionConfigKeys = [
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
