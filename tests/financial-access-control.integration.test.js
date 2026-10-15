import assert from 'node:assert/strict'
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

test('financial records and ID-based actions remain isolated between users', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grounded-access-control-'))
  const databasePath = path.join(directory, 'grounded-test.sqlite')
  const port = await reservePort()
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
      PORT: String(port),
      DATABASE_PATH: databasePath,
      JWT_SECRET: 'test-access-control-secret-with-at-least-32-characters',
      ALLOWED_ORIGINS: 'http://localhost:3000',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      SMTP_FROM: '',
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      STRIPE_PRICE_MONTHLY: '',
      STRIPE_PRICE_ANNUAL: '',
      GOOGLE_CLIENT_ID: '',
      PLAID_CLIENT_ID: '',
      PLAID_SECRET: '',
      BANK_TOKEN_ENCRYPTION_KEY: '',
      PLAID_ENV: 'sandbox',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  server.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  server.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  const serverExit = once(server, 'exit')

  t.after(async () => {
    if (server.exitCode === null) server.kill('SIGTERM')
    await serverExit
    await rm(directory, { recursive: true, force: true })
  })

  const baseUrl = `http://127.0.0.1:${port}`
  let ready = false
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
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
  assert.equal(ready, true, `API did not start. Output: ${output}`)

  const request = async (route, { token, method = 'GET', body } = {}) => fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const signup = async (name, email) => {
    const response = await request('/api/auth/signup', { method: 'POST', body: { name, email, password: 'secure-test-password-long' } })
    assert.equal(response.status, 201)
    return (await response.json()).token
  }

  const alice = await signup('Alice Test', 'alice-access@example.test')
  const bob = await signup('Bob Test', 'bob-access@example.test')

  const taskResponse = await request('/api/tasks', {
    token: alice,
    method: 'POST',
    body: { title: 'Private task', category: 'Finance', due: 'Today', priority: 'High' },
  })
  assert.equal(taskResponse.status, 201)
  const task = await taskResponse.json()
  const crossUserToggle = await request(`/api/tasks/${task.id}/toggle`, { token: bob, method: 'PATCH' })
  assert.equal(crossUserToggle.status, 404)
  const aliceTasksBeforeToggle = await request('/api/tasks', { token: alice })
  assert.equal((await aliceTasksBeforeToggle.json())[0].completed, 0)

  const ownToggle = await request(`/api/tasks/${task.id}/toggle`, { token: alice, method: 'PATCH' })
  assert.equal(ownToggle.status, 200)

  const account = await request('/api/accounts', {
    token: alice,
    method: 'POST',
    body: { name: 'Private checking', type: 'Checking', balance: 876.54 },
  })
  assert.equal(account.status, 201)

  const transaction = await request('/api/transactions', {
    token: alice,
    method: 'POST',
    body: { description: 'Private expense', amount: 42, category: 'Food', type: 'Expense' },
  })
  assert.equal(transaction.status, 201)

  const bill = await request('/api/bills', {
    token: alice,
    method: 'POST',
    body: { name: 'Private bill', amount: 75, frequency: 'Monthly', dueDate: '2026-11-01', category: 'Utilities', isFixed: true },
  })
  assert.equal(bill.status, 201)

  const income = await request('/api/income', {
    token: alice,
    method: 'POST',
    body: { source: 'Private job', amount: 500, frequency: 'Weekly', nextDate: '2026-10-20' },
  })
  assert.equal(income.status, 201)

  const subscription = await request('/api/subscriptions', {
    token: alice,
    method: 'POST',
    body: { merchant: 'Private subscription', amount: 9.99, frequency: 'Monthly', nextDate: '2026-11-01', status: 'Active' },
  })
  assert.equal(subscription.status, 201)

  const goal = await request('/api/goals', {
    token: alice,
    method: 'POST',
    body: { name: 'Private savings goal', target: 1000, date: '2027-01-01', contribution: 'Weekly' },
  })
  assert.equal(goal.status, 201)

  const bobDashboardResponse = await request('/api/dashboard', { token: bob })
  assert.equal(bobDashboardResponse.status, 200)
  const bobDashboard = await bobDashboardResponse.json()
  for (const collection of ['tasks', 'goals', 'transactions', 'bills', 'incomes', 'subscriptions', 'accounts']) {
    assert.deepEqual(bobDashboard[collection], [], `Bob must not receive Alice's ${collection}`)
  }
  for (const route of ['/api/tasks', '/api/goals', '/api/transactions', '/api/bills', '/api/income', '/api/subscriptions']) {
    const response = await request(route, { token: bob })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), [], `Bob must not read Alice's records from ${route}`)
  }

  const aliceNotificationsResponse = await request('/api/notifications', { token: alice })
  const aliceNotifications = await aliceNotificationsResponse.json()
  assert.ok(aliceNotifications.notifications.length > 0)
  const notificationId = aliceNotifications.notifications[0].id
  const crossUserNotificationRead = await request(`/api/notifications/${notificationId}/read`, { token: bob, method: 'POST' })
  assert.equal(crossUserNotificationRead.status, 404)
});
