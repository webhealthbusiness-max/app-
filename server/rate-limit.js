import { createHmac } from 'node:crypto'

const MAX_RATE_LIMIT_KEYS = 50000

export const createRateLimiter = ({ db, secret, windowMs, now = Date.now, maxKeys = MAX_RATE_LIMIT_KEYS }) => {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('A SQLite database is required.')
  if (typeof secret !== 'string' || secret.length < 32) throw new TypeError('A rate-limit hashing secret is required.')
  if (!Number.isInteger(windowMs) || windowMs < 1000 || windowMs > 3600000) throw new TypeError('A valid rate-limit window is required.')
  if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new TypeError('A positive rate-limit key bound is required.')

  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limit_buckets (
      key_hash TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rate_limit_buckets_reset_at_idx ON rate_limit_buckets(reset_at);
  `)

  const countKeys = db.prepare('SELECT COUNT(*) AS count FROM rate_limit_buckets')
  const findKey = db.prepare('SELECT 1 FROM rate_limit_buckets WHERE key_hash = ?')
  const removeExpired = db.prepare('DELETE FROM rate_limit_buckets WHERE reset_at <= ?')
  const increment = db.prepare(`
    INSERT INTO rate_limit_buckets (key_hash, count, reset_at)
    VALUES (?, 1, ?)
    ON CONFLICT(key_hash) DO UPDATE SET
      count = CASE WHEN rate_limit_buckets.reset_at <= ? THEN 1 ELSE rate_limit_buckets.count + 1 END,
      reset_at = CASE WHEN rate_limit_buckets.reset_at <= ? THEN ? ELSE rate_limit_buckets.reset_at END
    RETURNING count
  `)
  let operations = 0

  const consume = (key, maxRequests) => {
    if (typeof key !== 'string' || !key || !Number.isInteger(maxRequests) || maxRequests < 1) return false
    const time = now()
    const keyHash = createHmac('sha256', secret).update(key).digest('hex')
    operations += 1

    if (operations % 100 === 0 || countKeys.get().count >= maxKeys && !findKey.get(keyHash)) {
      removeExpired.run(time)
    }
    if (!findKey.get(keyHash) && countKeys.get().count >= maxKeys) return false

    const result = increment.get(keyHash, time + windowMs, time, time, time)
    return result.count <= maxRequests
  }

  return { consume }
}
