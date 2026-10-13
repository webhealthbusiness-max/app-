import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import bcrypt from 'bcryptjs'
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

const hashToken = (token) => createHash('sha256').update(token).digest('hex')

test('email verification is required, verification links are single-use, and password reset revokes old sessions', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grounded-auth-recovery-'))
  const databasePath = path.join(directory, 'grounded-test.sqlite')
  const port = await reservePort()
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
      PORT: String(port),
      DATABASE_PATH: databasePath,
      JWT_SECRET: 'test-auth-recovery-secret-with-at-least-32-characters',
      ALLOWED_ORIGINS: 'http://localhost:3000',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1',
      SMTP_USER: 'test-user',
      SMTP_PASS: 'test-password',
      SMTP_FROM: 'grounded-test@example.test',
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      STRIPE_PRICE_MONTHLY: '',
      STRIPE_PRICE_ANNUAL: '',
      APP_BASE_URL: 'http://localhost:3000',
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

  const email = 'recovery-test@example.test'
  const oldPassword = 'original-password-long-enough'
  const newPassword = 'replacement-password-long-enough'
  const db = new Database(databasePath)
  const insert = db.prepare('INSERT INTO users (name, email, password_hash, email_verified) VALUES (?, ?, ?, 0)')
  const userId = insert.run('Recovery Test', email, bcrypt.hashSync(oldPassword, 4)).lastInsertRowid
  db.prepare('INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, datetime(\'now\', \'+24 hours\'))')
    .run(hashToken('a'.repeat(64)), userId, 'verify_email')
  db.close()

  const post = async (route, body) => fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const blockedLogin = await post('/api/auth/login', { email, password: oldPassword })
  assert.equal(blockedLogin.status, 403)
  assert.equal((await blockedLogin.json()).code, 'EMAIL_NOT_VERIFIED')

  const verification = await post('/api/auth/verify-email', { token: 'a'.repeat(64) })
  assert.equal(verification.status, 200)
  assert.equal((await verification.json()).verified, true)
  const replayedVerification = await post('/api/auth/verify-email', { token: 'a'.repeat(64) })
  assert.equal(replayedVerification.status, 400, 'verification tokens must be single-use')

  const login = await post('/api/auth/login', { email, password: oldPassword })
  assert.equal(login.status, 200)
  const sessionToken = (await login.json()).token
  assert.ok(sessionToken)

  const dbForReset = new Database(databasePath)
  dbForReset.prepare('INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, datetime(\'now\', \'+1 hour\'))')
    .run(hashToken('b'.repeat(64)), userId, 'reset_password')
  dbForReset.prepare('INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, datetime(\'now\', \'-1 minute\'))')
    .run(hashToken('c'.repeat(64)), userId, 'reset_password')
  dbForReset.close()


  const reset = await post('/api/auth/password-reset/complete', { token: 'b'.repeat(64), password: newPassword })
  assert.equal(reset.status, 200)

  const staleSession = await fetch(`${baseUrl}/api/dashboard`, { headers: { Authorization: `Bearer ${sessionToken}` } })
  assert.equal(staleSession.status, 401, 'password reset must revoke sessions issued before the reset')

  const oldPasswordLogin = await post('/api/auth/login', { email, password: oldPassword })
  assert.equal(oldPasswordLogin.status, 401)
  const newPasswordLogin = await post('/api/auth/login', { email, password: newPassword })
  assert.equal(newPasswordLogin.status, 200)

  const replayedReset = await post('/api/auth/password-reset/complete', { token: 'b'.repeat(64), password: oldPassword })
  assert.equal(replayedReset.status, 400, 'password-reset tokens must be single-use')
  const expiredReset = await post('/api/auth/password-reset/complete', { token: 'c'.repeat(64), password: oldPassword })
  assert.equal(expiredReset.status, 400, 'expired password-reset tokens must be rejected')
})
