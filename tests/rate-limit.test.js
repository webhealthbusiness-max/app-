import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { test } from 'node:test'
import { createRateLimiter } from '../server/rate-limit.js'

const secret = 'synthetic-rate-limit-hmac-secret-at-least-32-bytes'

test('SQLite rate limits survive limiter recreation, reset expired windows, and store no raw subjects', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  let time = 1000
  const first = createRateLimiter({ db, secret, windowMs: 5000, now: () => time })

  assert.equal(first.consume('login:ip:192.0.2.4', 2), true)
  assert.equal(first.consume('login:subject:sample@example.test', 2), true)
  assert.equal(first.consume('login:subject:sample@example.test', 2), true)
  assert.equal(first.consume('login:ip:192.0.2.4', 2), true)

  const afterRestart = createRateLimiter({ db, secret, windowMs: 5000, now: () => time })
  assert.equal(afterRestart.consume('login:ip:192.0.2.4', 2), false)
  assert.equal(afterRestart.consume('login:subject:sample@example.test', 2), false)
  assert.equal(db.prepare('SELECT key_hash FROM rate_limit_buckets').all().some(({ key_hash }) => key_hash.includes('sample@example.test')), false)

  time += 5001
  assert.equal(afterRestart.consume('login:subject:sample@example.test', 2), true)
})

test('SQLite rate limits bound key cardinality but recycle expired keys', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  let time = 1000
  const limiter = createRateLimiter({ db, secret, windowMs: 1000, now: () => time, maxKeys: 2 })

  assert.equal(limiter.consume('ip:a', 3), true)
  assert.equal(limiter.consume('ip:b', 3), true)
  assert.equal(limiter.consume('ip:c', 3), false)

  time += 1001
  assert.equal(limiter.consume('ip:c', 3), true)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rate_limit_buckets').get().count, 1)
})
