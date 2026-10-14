import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
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

test('password reset validates tokens, updates password once, and revokes prior sessions', async (t) => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'grounded-password-reset-test-'))
  const databasePath = path.join(tempDirectory, 'test.db')
  const port = await reservePort()
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_PATH: databasePath,
      JWT_SECRET: 'test-secret-with-at-least-thirty-two-characters',
      ALLOWED_ORIGINS: 'http://localhost:3000',
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
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

  const jsonPost = async (route, payload) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { response, body: await response.json() }
  }

  const signup = await jsonPost('/api/auth/signup', {
    name: 'Reset Test',
    email: 'reset-test@example.com',
    password: 'original-password-123',
  })
  assert.equal(signup.response.status, 201)
  const oldSessionHeaders = { Authorization: `Bearer ${signup.body.token}` }

  // With SMTP disabled, both known and unknown addresses must receive the same public response.
  const knownRequest = await jsonPost('/api/auth/password-reset/request', { email: 'reset-test@example.com' })
  const unknownRequest = await jsonPost('/api/auth/password-reset/request', { email: 'not-a-user@example.com' })
  assert.equal(knownRequest.response.status, 200)
  assert.deepEqual(knownRequest.body, unknownRequest.body)

  const malformedToken = await jsonPost('/api/auth/password-reset/complete', {
    token: 'not-a-token',
    password: 'new-password-123',
  })
  assert.equal(malformedToken.response.status, 400)

  const shortPassword = await jsonPost('/api/auth/password-reset/complete', {
    token: randomBytes(32).toString('hex'),
    password: 'too-short',
  })
  assert.equal(shortPassword.response.status, 400)

  const rawToken = randomBytes(32).toString('hex')
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  const database = new Database(databasePath)
  const user = database.prepare('SELECT id FROM users WHERE email = ?').get('reset-test@example.com')
  assert.ok(user)
  database.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
    .run(user.id, tokenHash, Date.now() + 30 * 60 * 1000)
  database.close()

  const completed = await jsonPost('/api/auth/password-reset/complete', {
    token: rawToken,
    password: 'replacement-password-456',
  })
  assert.equal(completed.response.status, 200)

  const replay = await jsonPost('/api/auth/password-reset/complete', {
    token: rawToken,
    password: 'another-replacement-789',
  })
  assert.equal(replay.response.status, 400)

  const staleSession = await fetch(`${baseUrl}/api/dashboard`, { headers: oldSessionHeaders })
  assert.equal(staleSession.status, 401)

  const oldPasswordLogin = await jsonPost('/api/auth/login', {
    email: 'reset-test@example.com',
    password: 'original-password-123',
  })
  assert.equal(oldPasswordLogin.response.status, 401)

  const newPasswordLogin = await jsonPost('/api/auth/login', {
    email: 'reset-test@example.com',
    password: 'replacement-password-456',
  })
  assert.equal(newPasswordLogin.response.status, 200)
  assert.ok(newPasswordLogin.body.token)

  const expiredRawToken = randomBytes(32).toString('hex')
  const expiredHash = createHash('sha256').update(expiredRawToken).digest('hex')
  const expiredDatabase = new Database(databasePath)
  expiredDatabase.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
    .run(user.id, expiredHash, Date.now() - 1000)
  expiredDatabase.close()

  const expired = await jsonPost('/api/auth/password-reset/complete', {
    token: expiredRawToken,
    password: 'expired-link-password-123',
  })
  assert.equal(expired.response.status, 400)
})
