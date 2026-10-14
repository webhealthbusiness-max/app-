import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import Database from 'better-sqlite3'
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

test('auth, finance data isolation, validation, export, and deletion', async (t) => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'grounded-api-test-'))
  const databasePath = path.join(tempDirectory, 'test.db')
  const legacyDatabase = new Database(databasePath)
  legacyDatabase.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      amount INTEGER NOT NULL,
      category TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE billing_subscriptions (
      user_id INTEGER PRIMARY KEY,
      stripe_customer_id TEXT UNIQUE,
      stripe_subscription_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'free',
      price_id TEXT,
      current_period_end TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)
  legacyDatabase.close()
  const port = await reservePort()
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TRUST_PROXY_HOPS: '1',
      PORT: String(port),
      DATABASE_PATH: databasePath,
      JWT_SECRET: 'test-secret-with-at-least-thirty-two-characters',
      ALLOWED_ORIGINS: 'http://localhost:3000',
      STRIPE_SECRET_KEY: 'sk_test_local-integration',
      STRIPE_WEBHOOK_SECRET: 'whsec_local-integration-secret',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      SMTP_FROM: '',
      GOOGLE_CLIENT_ID: '',
      PLAID_CLIENT_ID: '',
      PLAID_SECRET: '',
      BANK_TOKEN_ENCRYPTION_KEY: '',
      PLAID_ENV: 'sandbox',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverOutput = ''
  server.stdout.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk })
  server.stderr.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk })
  const serverExit = once(server, 'exit')

  t.after(async () => {
    if (server.exitCode === null) server.kill('SIGTERM')
    await serverExit
    await rm(tempDirectory, { recursive: true, force: true })
  })

  const baseUrl = `http://127.0.0.1:${port}`
  let ready = false
  const startupDeadline = Date.now() + 10000
  while (Date.now() < startupDeadline) {
    if (server.exitCode !== null) break
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
  assert.equal(ready, true, `API did not start. Output: ${serverOutput}`)

  const rateLimitProbe = (ip) => fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ name: 'Rate Limit Probe', email: `probe-${ip.replaceAll('.', '-')}@example.com`, password: 'short' }),
  })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await rateLimitProbe('198.51.100.10')).status, 400)
  }
  assert.equal((await rateLimitProbe('198.51.100.10')).status, 429)
  assert.equal((await rateLimitProbe('198.51.100.11')).status, 400)

  const signup = async (name, email) => {
    const response = await fetch(`${baseUrl}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password: 'correct-horse-battery' }),
    })
    return { response, body: await response.json() }
  }

  const shortPassword = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Invalid', email: 'invalid@example.com', password: 'short' }),
  })
  assert.equal(shortPassword.status, 400)

  const first = await signup('Test User', 'test@example.com')
  assert.equal(first.response.status, 201)
  assert.ok(first.body.token)
  const firstHeaders = { Authorization: `Bearer ${first.body.token}`, 'Content-Type': 'application/json' }

  const dashboardResponse = await fetch(`${baseUrl}/api/dashboard`, { headers: firstHeaders })
  assert.equal(dashboardResponse.status, 200)
  assert.equal(dashboardResponse.headers.get('cache-control'), 'no-store')
  assert.equal(dashboardResponse.headers.get('x-content-type-options'), 'nosniff')
  const dashboard = await dashboardResponse.json()
  assert.equal(dashboard.profile.currentMoney, 0)
  assert.deepEqual(dashboard.tasks, [])
  assert.deepEqual(dashboard.goals, [])
  assert.deepEqual(dashboard.transactions, [])
  assert.deepEqual(dashboard.bills, [])
  assert.deepEqual(dashboard.incomes, [])
  assert.deepEqual(dashboard.subscriptions, [])
  assert.deepEqual(dashboard.accounts, [])

  const bankingStatusResponse = await fetch(`${baseUrl}/api/banking/status`, { headers: firstHeaders })
  const bankingStatus = await bankingStatusResponse.json()
  assert.equal(bankingStatusResponse.status, 200)
  assert.equal(bankingStatus.enabled, false)
  assert.deepEqual(bankingStatus.connections, [])
  const linkNotConfigured = await fetch(`${baseUrl}/api/banking/link-token`, {
    method: 'POST',
    headers: firstHeaders,
  })
  assert.equal(linkNotConfigured.status, 503)
  const syncNotConfigured = await fetch(`${baseUrl}/api/banking/sync`, {
    method: 'POST',
    headers: firstHeaders,
  })
  assert.equal(syncNotConfigured.status, 503)

  const manualAccount = await fetch(`${baseUrl}/api/accounts`, {
    method: 'POST',
    headers: firstHeaders,
    body: JSON.stringify({ name: 'Everyday checking', type: 'Checking', balance: 1250.5 }),
  })
  assert.equal(manualAccount.status, 201)
  assert.equal((await manualAccount.json()).status, 'Manual')
  const dashboardWithAccountResponse = await fetch(`${baseUrl}/api/dashboard`, { headers: firstHeaders })
  const dashboardWithAccount = await dashboardWithAccountResponse.json()
  assert.equal(dashboardWithAccount.accounts.length, 1)
  assert.equal(dashboardWithAccount.accounts[0].balance, 1250.5)

  const signupNotificationsResponse = await fetch(`${baseUrl}/api/notifications`, { headers: firstHeaders })
  const signupNotifications = await signupNotificationsResponse.json()
  assert.equal(signupNotificationsResponse.status, 200)
  assert.equal(signupNotifications.emailEnabled, false)
  assert.ok(signupNotifications.notifications.some((item) => item.event === 'account_created'))
  assert.ok(signupNotifications.notifications.some((item) => item.event === 'manual_account_added'))
  const firstUnread = signupNotifications.notifications.find((item) => !item.readAt)
  const markRead = await fetch(`${baseUrl}/api/notifications/${firstUnread.id}/read`, {
    method: 'POST',
    headers: firstHeaders,
  })
  assert.equal(markRead.status, 200)

  const passwordLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'correct-horse-battery' }),
  })
  assert.equal(passwordLogin.status, 200)
  const signInNotifications = await fetch(`${baseUrl}/api/notifications`, { headers: firstHeaders })
  assert.ok((await signInNotifications.json()).notifications.some((item) => item.event === 'sign_in'))

  const googleNotConfigured = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: 'untrusted-token' }),
  })
  assert.equal(googleNotConfigured.status, 503)

  const billingStatus = await fetch(`${baseUrl}/api/billing/status`, { headers: firstHeaders })
  assert.equal(billingStatus.status, 200)
  const billing = await billingStatus.json()
  assert.equal(billing.plan, 'free')
  assert.equal(billing.prices.monthly, 5.99)
  assert.equal(billing.prices.annual, 59.99)

  const unconfiguredCheckout = await fetch(`${baseUrl}/api/billing/checkout`, {
    method: 'POST',
    headers: firstHeaders,
    body: JSON.stringify({ interval: 'monthly' }),
  })
  assert.equal(unconfiguredCheckout.status, 503)

  const lockedInsights = await fetch(`${baseUrl}/api/premium/insights`, { headers: firstHeaders })
  assert.equal(lockedInsights.status, 402)
  assert.equal((await lockedInsights.json()).code, 'PLUS_REQUIRED')

  const billingDatabase = new Database(databasePath)
  billingDatabase.prepare(`
    INSERT INTO billing_subscriptions (user_id, stripe_customer_id, checkout_session_id)
    VALUES (?, 'cus_test_plus', 'cs_pending_test')
  `).run(first.body.user.id)
  billingDatabase.close()

  for (let index = 0; index < 3; index += 1) {
    const goal = await fetch(`${baseUrl}/api/goals`, {
      method: 'POST',
      headers: firstHeaders,
      body: JSON.stringify({ name: `Goal ${index + 1}`, target: 100 }),
    })
    assert.equal(goal.status, 201)
  }
  const limitedGoal = await fetch(`${baseUrl}/api/goals`, {
    method: 'POST',
    headers: firstHeaders,
    body: JSON.stringify({ name: 'Fourth goal', target: 100 }),
  })
  assert.equal(limitedGoal.status, 402)
  assert.equal((await limitedGoal.json()).code, 'PLUS_REQUIRED')

  const subscriptionEvent = JSON.stringify({
    id: 'evt_test_subscription_active',
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_test_plus',
        object: 'subscription',
        customer: 'cus_test_plus',
        status: 'active',
        current_period_end: 1792000000,
        metadata: { userId: String(first.body.user.id) },
        items: { data: [{ price: { id: 'price_monthly_test' } }] },
      },
    },
  })
  const timestamp = Math.floor(Date.now() / 1000)
  const invalidWebhook = await fetch(`${baseUrl}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=invalid` },
    body: subscriptionEvent,
  })
  assert.equal(invalidWebhook.status, 400)

  const signature = createHmac('sha256', 'whsec_local-integration-secret')
    .update(`${timestamp}.${subscriptionEvent}`)
    .digest('hex')
  const webhookResponse = await fetch(`${baseUrl}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=${signature}` },
    body: subscriptionEvent,
  })
  assert.equal(webhookResponse.status, 200)

  const activeBillingResponse = await fetch(`${baseUrl}/api/billing/status`, { headers: firstHeaders })
  assert.equal((await activeBillingResponse.json()).plan, 'plus')
  const verifiedBillingDatabase = new Database(databasePath)
  assert.equal(verifiedBillingDatabase.prepare('SELECT checkout_session_id FROM billing_subscriptions WHERE user_id = ?')
    .get(first.body.user.id).checkout_session_id, null)
  verifiedBillingDatabase.close()

  const unlimitedGoal = await fetch(`${baseUrl}/api/goals`, {
    method: 'POST',
    headers: firstHeaders,
    body: JSON.stringify({ name: 'Plus goal', target: 100 }),
  })
  assert.equal(unlimitedGoal.status, 201)

  const blockedOrigin = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://untrusted.example' } })
  assert.equal(blockedOrigin.status, 403)

  const malformedBody = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"email":',
  })
  assert.equal(malformedBody.status, 400)

  const invalidProfile = await fetch(`${baseUrl}/api/profile`, {
    method: 'POST',
    headers: firstHeaders,
    body: JSON.stringify({
      name: 'Test User',
      monthlyIncome: -1,
      currentMoney: 0,
      fixedExpenses: 0,
      plannedSpending: 0,
      savingsAllocation: 0,
    }),
  })
  assert.equal(invalidProfile.status, 400)

  const savedProfile = await fetch(`${baseUrl}/api/profile`, {
    method: 'POST',
    headers: firstHeaders,
    body: JSON.stringify({
      name: 'Updated User',
      monthlyIncome: 1000,
      currentMoney: 500,
      fixedExpenses: 200,
      plannedSpending: 100,
      savingsAllocation: 50,
      trackingMode: 'Manual',
      focusAreas: ['Saving money'],
    }),
  })
  assert.equal(savedProfile.status, 200)
  const savedDashboard = await savedProfile.json()
  assert.equal(savedDashboard.user.name, 'Updated User')
  assert.equal(savedDashboard.projectedBalance, 1150)

  const createTransaction = await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST',
    headers: firstHeaders,
    body: JSON.stringify({ description: 'Test income', amount: 250, category: 'Work', type: 'Income' }),
  })
  assert.equal(createTransaction.status, 201)
  const updatedDashboard = await fetch(`${baseUrl}/api/dashboard`, { headers: firstHeaders })
  assert.equal((await updatedDashboard.json()).profile.currentMoney, 750)

  const createExpense = await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST',
    headers: firstHeaders,
    body: JSON.stringify({ description: 'Groceries', amount: 40, category: 'Food', type: 'Expense' }),
  })
  assert.equal(createExpense.status, 201)

  const insightsResponse = await fetch(`${baseUrl}/api/premium/insights`, { headers: firstHeaders })
  assert.equal(insightsResponse.status, 200)
  const insights = await insightsResponse.json()
  assert.equal(insights.totalSpent, 40)
  assert.equal(insights.categories[0].category, 'Food')

  const second = await signup('Other User', 'other@example.com')
  assert.equal(second.response.status, 201)
  const otherDashboard = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { Authorization: `Bearer ${second.body.token}` },
  })
  const otherData = await otherDashboard.json()
  assert.deepEqual(otherData.transactions, [])

  const exported = await fetch(`${baseUrl}/api/data/export`, { headers: firstHeaders })
  assert.equal(exported.status, 200)
  const exportedData = await exported.json()
  assert.equal(exportedData.transactions.length, 2)
  assert.equal(exportedData.user.name, 'Updated User')
  assert.equal(exportedData.billing.plan, 'plus')
  assert.equal(exportedData.accounts.length, 1)
  assert.ok(exportedData.notifications.some((item) => item.event === 'account_created'))

  const secondHeaders = { Authorization: 'Bearer ' + second.body.token, 'Content-Type': 'application/json' }
  const deleted = await fetch(`${baseUrl}/api/data/delete`, { method: 'DELETE', headers: secondHeaders })
  assert.equal(deleted.status, 200)
  const deletedSession = await fetch(`${baseUrl}/api/dashboard`, { headers: secondHeaders })
  assert.equal(deletedSession.status, 401)

  const lateSubscriptionEvent = JSON.stringify({
    id: 'evt_late_deleted_user',
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_deleted_user',
        object: 'subscription',
        customer: 'cus_deleted_user',
        status: 'active',
        metadata: { userId: String(second.body.user.id) },
      },
    },
  })
  const lateTimestamp = Math.floor(Date.now() / 1000)
  const lateSignature = createHmac('sha256', 'whsec_local-integration-secret')
    .update(`${lateTimestamp}.${lateSubscriptionEvent}`)
    .digest('hex')
  const lateWebhook = await fetch(`${baseUrl}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${lateTimestamp},v1=${lateSignature}` },
    body: lateSubscriptionEvent,
  })
  assert.equal(lateWebhook.status, 200)
})

test('production refuses to start without production secrets and storage settings', () => {
  const env = { ...process.env, NODE_ENV: 'production' }
  delete env.JWT_SECRET
  delete env.ALLOWED_ORIGINS
  delete env.DATABASE_PATH
  const result = spawnSync(process.execPath, ['server/index.js'], { cwd: process.cwd(), env, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /JWT_SECRET of at least 32 characters/)
})

test('production requires Stripe configuration before enabling paid plans', () => {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    JWT_SECRET: 'production-test-secret-that-is-at-least-32-characters',
    ALLOWED_ORIGINS: 'https://grounded.example',
    DATABASE_PATH: '/tmp/grounded-production-test.db',
  }
  delete env.STRIPE_SECRET_KEY
  delete env.STRIPE_WEBHOOK_SECRET
  delete env.STRIPE_PRICE_MONTHLY
  delete env.STRIPE_PRICE_ANNUAL
  delete env.APP_BASE_URL
  const result = spawnSync(process.execPath, ['server/index.js'], { cwd: process.cwd(), env, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Stripe keys, monthly and annual price IDs, and APP_BASE_URL/)
})

test('production requires complete SMTP configuration for email alerts', () => {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    JWT_SECRET: 'production-test-secret-that-is-at-least-32-characters',
    ALLOWED_ORIGINS: 'https://grounded.example',
    DATABASE_PATH: '/tmp/grounded-production-test.db',
    STRIPE_SECRET_KEY: 'sk_live_local-test-value',
    STRIPE_WEBHOOK_SECRET: 'whsec_local-test-value',
    STRIPE_PRICE_MONTHLY: 'price_monthly_test',
    STRIPE_PRICE_ANNUAL: 'price_annual_test',
    APP_BASE_URL: 'https://grounded.example',
    SMTP_HOST: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    SMTP_FROM: '',
  }
  const result = spawnSync(process.execPath, ['server/index.js'], { cwd: process.cwd(), env, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM are required/)
})

test('bank-link credentials require a valid encryption key', () => {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PLAID_CLIENT_ID: 'sandbox-client-id',
    PLAID_SECRET: 'sandbox-secret',
    BANK_TOKEN_ENCRYPTION_KEY: 'not-a-32-byte-hex-key',
    PLAID_ENV: 'sandbox',
  }
  const result = spawnSync(process.execPath, ['server/index.js'], { cwd: process.cwd(), env, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /BANK_TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters/)
})

test('rejects an invalid trusted proxy hop count', () => {
  const env = { ...process.env, NODE_ENV: 'test', TRUST_PROXY_HOPS: 'not-a-number' }
  const result = spawnSync(process.execPath, ['server/index.js'], { cwd: process.cwd(), env, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /TRUST_PROXY_HOPS must be an integer between 1 and 5/)
})
