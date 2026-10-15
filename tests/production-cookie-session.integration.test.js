import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import Database from 'better-sqlite3'
import { createHmac } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const reservePort = async () => {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

test('production sessions use secure cookies, require CSRF proof, and revoke on logout', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grounded-cookie-session-'))
  const databasePath = path.join(directory, 'grounded-test.sqlite')
  const fixture = new Database(databasePath)
  fixture.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0,
      email_verified INTEGER NOT NULL DEFAULT 1,
      google_sub TEXT
    );
    CREATE TABLE billing_subscriptions (
      user_id INTEGER PRIMARY KEY,
      stripe_customer_id TEXT UNIQUE,
      checkout_session_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'free',
      price_id TEXT,
      current_period_end TEXT,
      stripe_event_created INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO billing_subscriptions (user_id, stripe_customer_id) VALUES (1, 'cus_synthetic_cookie_test');
  `)
  fixture.prepare('INSERT INTO users (name, email, password_hash, email_verified) VALUES (?, ?, ?, 1)')
    .run('Synthetic Cookie User', 'cookie-user@example.test', bcrypt.hashSync('synthetic-test-password-12', 4))
  fixture.close()

  const port = await reservePort()
  const childEnv = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    APP_ENV: 'staging',
    PORT: String(port),
    DATABASE_PATH: databasePath,
    JWT_SECRET: 'synthetic-cookie-test-jwt-secret-at-least-32-bytes',
    ALLOWED_ORIGINS: 'https://grounded.example.test',
    STRIPE_SECRET_KEY: 'sk_test_synthetic_cookie_session',
    STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_cookie_session',
    STRIPE_PRICE_MONTHLY: 'price_test_monthly',
    STRIPE_PRICE_ANNUAL: 'price_test_annual',
    APP_BASE_URL: 'https://grounded.example.test',
    SMTP_HOST: '127.0.0.1',
    SMTP_USER: 'synthetic-user',
    SMTP_PASS: 'synthetic-password',
    SMTP_FROM: 'Grounded Test <no-reply@example.test>',
    SMTP_PORT: '1',
    GOOGLE_CLIENT_ID: '',
    PLAID_CLIENT_ID: '',
    PLAID_SECRET: '',
    BANK_TOKEN_ENCRYPTION_KEY: '',
    PLAID_ENV: 'sandbox',
  }
  const child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  const childExit = once(child, 'exit')
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    await childExit
    await rm(directory, { recursive: true, force: true })
  })

  const baseUrl = `http://127.0.0.1:${port}`
  let ready = false
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  assert.equal(ready, true, 'production-mode test server did not start with synthetic configuration')

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'cookie-user@example.test', password: 'synthetic-test-password-12' }),
  })
  assert.equal(loginResponse.status, 200)
  const loginBody = await loginResponse.json()
  assert.equal('token' in loginBody, false, 'production must not expose a bearer JWT in JSON')
  assert.ok(loginBody.user)
  const setCookies = loginResponse.headers.getSetCookie()
  assert.equal(setCookies.length, 2)
  assert.match(setCookies[0], /grounded_session=.*HttpOnly; SameSite=Lax; Max-Age=604800; Secure/)
  assert.match(setCookies[1], /grounded_csrf=.*SameSite=Lax; Max-Age=604800; Secure/)
  const cookieHeader = setCookies.map((value) => value.split(';')[0]).join('; ')
  const csrfToken = cookieHeader.split('; ').find((value) => value.startsWith('grounded_csrf=')).slice('grounded_csrf='.length)

  const me = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookieHeader } })
  assert.equal(me.status, 200)
  assert.equal((await me.json()).user.email, 'cookie-user@example.test')

  const missingCsrf = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Blocked task', category: 'Test', due: 'Today' }),
  })
  assert.equal(missingCsrf.status, 403)

  const validWrite = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ title: 'Synthetic task', category: 'Test', due: 'Today', priority: 'Low' }),
  })
  assert.equal(validWrite.status, 201)

  const sendStripeEvent = async (event) => {
    const rawBody = JSON.stringify(event)
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = createHmac('sha256', childEnv.STRIPE_WEBHOOK_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex')
    return fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=${signature}` },
      body: rawBody,
    })
  }
  const activeSubscription = {
    id: 'sub_synthetic_cookie_test',
    customer: 'cus_synthetic_cookie_test',
    status: 'active',
    metadata: { userId: '1' },
    items: { data: [{ price: { id: 'price_test_monthly' } }] },
    current_period_end: 1893456000,
  }
  const firstEvent = { id: 'evt_synthetic_active', type: 'customer.subscription.updated', created: 2000000000, data: { object: activeSubscription } }
  assert.equal((await sendStripeEvent(firstEvent)).status, 200)
  assert.equal((await sendStripeEvent(firstEvent)).status, 200)
  const olderEvent = {
    id: 'evt_synthetic_older',
    type: 'customer.subscription.updated',
    created: 1999999999,
    data: { object: { ...activeSubscription, status: 'canceled' } },
  }
  assert.equal((await sendStripeEvent(olderEvent)).status, 200)
  const persistedBilling = new Database(databasePath)
  assert.deepEqual(
    persistedBilling.prepare('SELECT status, stripe_event_created FROM billing_subscriptions WHERE user_id = 1').get(),
    { status: 'active', stripe_event_created: 2000000000 },
  )
  assert.equal(persistedBilling.prepare('SELECT COUNT(*) AS count FROM stripe_webhook_events WHERE status = \'processed\'').get().count, 2)
  persistedBilling.close()

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfToken },
  })
  assert.equal(logout.status, 204)
  assert.ok(logout.headers.getSetCookie().every((value) => /Max-Age=0/.test(value)))
  const revoked = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookieHeader } })
  assert.equal(revoked.status, 401)
})
