import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlaidSync } from '../server/plaid-sync.js'

test('Plaid sync checkpoints a bounded batch and resumes from the saved cursor', async () => {
  const pages = Array.from({ length: 11 }, (_, index) => ({
    added: [],
    modified: [],
    removed: [],
    next_cursor: `cursor-${index + 1}`,
    has_more: index < 10,
  }))
  const requestedCursors = []
  let pageIndex = 0
  let persistedCursor = null

  const plaidClient = {
    transactionsSync: async ({ cursor }) => {
      requestedCursors.push(cursor ?? null)
      const page = pages[pageIndex++]
      assert.ok(page, 'test should not request more pages than are available')
      return { data: page }
    },
    accountsGet: async () => ({ data: { accounts: [] } }),
  }

  const db = {
    prepare(sql) {
      return {
        run(...args) {
          if (sql.includes('UPDATE bank_connections')) persistedCursor = args[0]
          return { changes: 1 }
        },
        get() {
          return undefined
        },
      }
    },
    transaction(callback) {
      return (...args) => callback(...args)
    },
  }

  const syncPlaidConnection = createPlaidSync({
    db,
    plaidClient,
    decryptBankAccessToken: () => 'synthetic-access-token',
    sanitizeText: (value, fallback = '') => value || fallback,
  })
  const connection = {
    item_id: 'synthetic-item',
    user_id: 42,
    cursor: 'cursor-0',
  }

  const firstBatch = await syncPlaidConnection(connection)
  assert.equal(firstBatch.complete, false)
  assert.equal(requestedCursors.length, 10)
  assert.equal(persistedCursor, 'cursor-10')

  const secondBatch = await syncPlaidConnection({
    ...connection,
    cursor: persistedCursor,
  })
  assert.equal(secondBatch.complete, true)
  assert.equal(requestedCursors.length, 11)
  assert.equal(requestedCursors[10], 'cursor-10')
  assert.equal(persistedCursor, 'cursor-11')
})
