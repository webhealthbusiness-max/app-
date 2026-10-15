import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { migrateDatabase } from '../server/migrations.js'

const createLegacyDatabase = () => {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
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
    );
    INSERT INTO users (name, email, password_hash) VALUES ('Synthetic User', 'migration@example.test', 'not-a-real-password');
    INSERT INTO accounts (user_id, name, type, balance) VALUES (1, 'Synthetic Checking', 'Checking', 125.50);
    INSERT INTO transactions (user_id, description, amount, category, type) VALUES (1, 'Synthetic deposit', 2500, 'Income', 'Income');
    INSERT INTO billing_subscriptions (user_id, status) VALUES (1, 'free');
  `)
  return db
}

test('versioned migration upgrades a legacy schema while preserving existing user data', (t) => {
  const db = createLegacyDatabase()
  t.after(() => db.close())

  assert.equal(migrateDatabase(db), 1)
  assert.deepEqual(
    db.prepare('SELECT name, email, email_verified, session_version FROM users WHERE id = 1').get(),
    { name: 'Synthetic User', email: 'migration@example.test', email_verified: 1, session_version: 0 },
  )
  assert.deepEqual(db.prepare('SELECT name, balance, plaid_account_id FROM accounts WHERE id = 1').get(), {
    name: 'Synthetic Checking',
    balance: 125.5,
    plaid_account_id: null,
  })
  assert.deepEqual(db.prepare('SELECT description, amount, source, provider_transaction_id FROM transactions WHERE id = 1').get(), {
    description: 'Synthetic deposit',
    amount: 2500,
    source: 'manual',
    provider_transaction_id: null,
  })
  assert.equal(db.prepare('SELECT checkout_session_id FROM billing_subscriptions WHERE user_id = 1').get().checkout_session_id, null)
  assert.equal(db.prepare('SELECT version, name FROM schema_migrations').get().version, 1)
})

test('migration runner is idempotent and does not alter data on restart', (t) => {
  const db = createLegacyDatabase()
  t.after(() => db.close())

  migrateDatabase(db)
  db.prepare('UPDATE accounts SET balance = ? WHERE id = 1').run(246.80)
  assert.equal(migrateDatabase(db), 1)
  assert.equal(db.prepare('SELECT balance FROM accounts WHERE id = 1').get().balance, 246.8)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 1)
})

test('migration runner refuses a schema version newer than the application', (t) => {
  const db = createLegacyDatabase()
  t.after(() => db.close())
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
  db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(1, 'synthetic-v1')
  db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(2, 'synthetic-future-v2')

  assert.throws(() => migrateDatabase(db), /Database schema is newer than this application version/)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 1)
})
