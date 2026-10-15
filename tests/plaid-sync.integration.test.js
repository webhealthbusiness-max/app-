import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { test } from 'node:test'
import { createPlaidSync } from '../server/plaid-sync.js'

const createDatabase = (databasePath = ':memory:') => {
  const db = new Database(databasePath)
  db.exec(
    "CREATE TABLE bank_connections (item_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, cursor TEXT, status TEXT NOT NULL, last_synced_at TEXT);" +
    "CREATE TABLE accounts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, balance REAL, plaid_account_id TEXT, plaid_item_id TEXT, mask TEXT, updated_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);" +
    "CREATE UNIQUE INDEX accounts_plaid_account_unique ON accounts(plaid_account_id) WHERE plaid_account_id IS NOT NULL;" +
    "CREATE TABLE transactions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL, category TEXT NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL, provider_transaction_id TEXT UNIQUE, account_id INTEGER, plaid_item_id TEXT);"
  )
  return db
}

const insertConnection = (db, cursor = null) => {
  db.prepare("INSERT INTO bank_connections (item_id, user_id, cursor, status) VALUES ('item-test', 7, ?, 'connected')").run(cursor)
}
const readConnection = (db) => db.prepare("SELECT * FROM bank_connections WHERE item_id = 'item-test'").get()
const makeSync = (db, plaidClient) => createPlaidSync({
  db,
  plaidClient,
  decryptBankAccessToken: () => 'synthetic-access-token',
  sanitizeText: (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback,
})
const plaidAccount = {
  account_id: 'account-test',
  name: 'Synthetic checking',
  type: 'depository',
  subtype: 'checking',
  mask: '1234',
  balances: { current: 100.25 },
}
const transaction = (id, amount = 12.34) => ({
  transaction_id: id,
  account_id: 'account-test',
  amount,
  date: '2026-10-01',
  name: 'Synthetic ' + id,
  personal_finance_category: { primary: 'GENERAL_MERCHANDISE' },
})
const page = ({ added = [], modified = [], removed = [], nextCursor, hasMore = false }) => ({
  data: { added, modified, removed, next_cursor: nextCursor, has_more: hasMore },
})
const accountsResponse = async () => ({ data: { accounts: [plaidAccount] } })

test('Plaid sync advances beyond ten pages and resumes from its committed cursor after a restart boundary', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grounded-plaid-pages-'))
  const databasePath = path.join(directory, 'synthetic.sqlite')
  let db = createDatabase(databasePath)
  insertConnection(db)
  t.after(async () => {
    if (db.open) db.close()
    await rm(directory, { recursive: true, force: true })
  })

  const requestedCursors = []
  const client = {
    async transactionsSync({ cursor }) {
      requestedCursors.push(cursor ?? null)
      const pageIndex = cursor ? Number(cursor.slice(1)) : 0
      return page({
        added: [transaction('txn-' + pageIndex)],
        nextCursor: 'c' + (pageIndex + 1),
        hasMore: pageIndex < 11,
      })
    },
    accountsGet: accountsResponse,
  }

  const firstBatch = await makeSync(db, client)(readConnection(db))
  assert.equal(firstBatch.complete, false)
  assert.equal(firstBatch.addedCount, 10)
  assert.equal(readConnection(db).cursor, 'c10')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 10)

  db.close()
  db = new Database(databasePath)
  const resumed = await makeSync(db, client)(readConnection(db))

  assert.equal(resumed.complete, true)
  assert.equal(resumed.addedCount, 2)
  assert.equal(readConnection(db).cursor, 'c12')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 12)
  assert.equal(requestedCursors[10], 'c10')
  assert.deepEqual(requestedCursors.slice(0, 10), Array.from({ length: 10 }, (_, index) => index === 0 ? null : 'c' + index))
})

test('duplicate pages and retry after partial provider failure preserve data and cursor consistency', async (t) => {
  const db = createDatabase()
  t.after(() => db.close())
  insertConnection(db)
  const duplicate = transaction('txn-replayed', 19.99)
  db.prepare("INSERT INTO transactions (user_id, description, amount, category, type, created_at, source, provider_transaction_id) VALUES (7, 'old modified value', 1, 'Old', 'Expense', '2026-09-01', 'bank', 'txn-modified')").run()
  db.prepare("INSERT INTO transactions (user_id, description, amount, category, type, created_at, source, provider_transaction_id) VALUES (7, 'removed value', 2, 'Old', 'Expense', '2026-09-01', 'bank', 'txn-removed')").run()

  let failSecondPage = true
  const requestedCursors = []
  const client = {
    async transactionsSync({ cursor }) {
      requestedCursors.push(cursor ?? null)
      if (!cursor) return page({ added: [duplicate], nextCursor: 'c1', hasMore: true })
      if (cursor === 'c1' && failSecondPage) throw new Error('synthetic transient Plaid failure')
      if (cursor === 'c1') {
        return page({
          added: [duplicate],
          modified: [transaction('txn-modified', 8.5)],
          removed: [{ transaction_id: 'txn-removed' }],
          nextCursor: 'c2',
        })
      }
      return page({ added: [duplicate], nextCursor: 'c3' })
    },
    accountsGet: accountsResponse,
  }
  const sync = makeSync(db, client)

  await assert.rejects(sync(readConnection(db)), /synthetic transient Plaid failure/)
  assert.equal(readConnection(db).cursor, null)
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE provider_transaction_id = 'txn-replayed'").get().count, 0)
  assert.equal(db.prepare("SELECT amount FROM transactions WHERE provider_transaction_id = 'txn-modified'").get().amount, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE provider_transaction_id = 'txn-removed'").get().count, 1)

  failSecondPage = false
  const retried = await sync(readConnection(db))
  assert.equal(retried.complete, true)
  assert.equal(retried.addedCount, 2)
  assert.equal(retried.modifiedCount, 1)
  assert.equal(readConnection(db).cursor, 'c2')
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE provider_transaction_id = 'txn-replayed'").get().count, 1)
  assert.equal(db.prepare("SELECT amount FROM transactions WHERE provider_transaction_id = 'txn-modified'").get().amount, 8.5)
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE provider_transaction_id = 'txn-removed'").get().count, 0)

  const replayed = await sync(readConnection(db))
  assert.equal(replayed.complete, true)
  assert.equal(readConnection(db).cursor, 'c3')
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE provider_transaction_id = 'txn-replayed'").get().count, 1)
  assert.deepEqual(requestedCursors, [null, 'c1', null, 'c1', 'c2'])
})
