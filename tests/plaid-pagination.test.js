import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchPlaidTransactionBatch } from '../server/plaid-pagination.js'

const pageFor = (index, hasMore) => ({
  added: [{ transaction_id: `tx-${index}` }],
  modified: [{ transaction_id: `modified-${index}` }],
  removed: [{ transaction_id: `removed-${index}` }],
  next_cursor: `cursor-${index}`,
  has_more: hasMore,
})

test('pagination resumes through more than ten pages across repeated runs and restart', async () => {
  const pages = Array.from({ length: 23 }, (_, index) => pageFor(index + 1, index < 22))
  const requests = []
  const plaidClient = { transactionsSync: async (request) => {
    requests.push(request.cursor || null)
    const index = request.cursor ? Number(request.cursor.slice(7)) : 0
    return { data: pages[index] }
  } }

  let savedCursor = null
  const received = []
  const modified = []
  const removed = []
  for (let run = 0; run < 3; run += 1) {
    const batch = await fetchPlaidTransactionBatch({ plaidClient, accessToken: 'synthetic-token', cursor: savedCursor })
    received.push(...batch.pages.flatMap((page) => page.added.map((transaction) => transaction.transaction_id)))
    modified.push(...batch.pages.flatMap((page) => page.modified.map((transaction) => transaction.transaction_id)))
    removed.push(...batch.pages.flatMap((page) => page.removed.map((transaction) => transaction.transaction_id)))
    savedCursor = batch.cursor // The application commits this with its page mutations.
    if (!batch.hasMore) break
  }

  assert.equal(received.length, 23)
  assert.equal(new Set(received).size, 23)
  assert.equal(modified.length, 23)
  assert.equal(new Set(modified).size, 23)
  assert.equal(removed.length, 23)
  assert.equal(new Set(removed).size, 23)
  assert.equal(savedCursor, 'cursor-23')
  assert.deepEqual(requests.slice(0, 12), [null, ...Array.from({ length: 11 }, (_, index) => `cursor-${index + 1}`)])
})

test('retrying a page after restart resumes from the last committed cursor', async () => {
  const requests = []
  const plaidClient = { transactionsSync: async ({ cursor }) => {
    requests.push(cursor || null)
    return { data: cursor ? pageFor(2, false) : pageFor(1, true) }
  } }

  const first = await fetchPlaidTransactionBatch({ plaidClient, accessToken: 'synthetic-token', cursor: null, maxPages: 1 })
  assert.equal(first.cursor, 'cursor-1')
  // Simulate process restart: a new call uses only the durably committed cursor.
  const resumed = await fetchPlaidTransactionBatch({ plaidClient, accessToken: 'synthetic-token', cursor: first.cursor, maxPages: 1 })
  assert.equal(resumed.cursor, 'cursor-2')
  assert.deepEqual(requests, [null, 'cursor-1'])
})

test('partial provider failure leaves the caller cursor untouched for a safe retry', async () => {
  let calls = 0
  const requestedCursors = []
  const plaidClient = { transactionsSync: async ({ cursor }) => {
    calls += 1
    requestedCursors.push(cursor || null)
    if (calls === 2) throw new Error('synthetic provider interruption')
    if (calls === 1 || calls === 3) return { data: pageFor(1, true) }
    return { data: pageFor(2, false) }
  } }
  const persistedCursor = 'prior-cursor'
  await assert.rejects(
    fetchPlaidTransactionBatch({ plaidClient, accessToken: 'synthetic-token', cursor: persistedCursor, maxPages: 3 }),
    /synthetic provider interruption/,
  )
  assert.equal(persistedCursor, 'prior-cursor')
  const retried = await fetchPlaidTransactionBatch({ plaidClient, accessToken: 'synthetic-token', cursor: persistedCursor, maxPages: 3 })
  assert.deepEqual(requestedCursors, ['prior-cursor', 'cursor-1', 'prior-cursor', 'cursor-1'])
  assert.deepEqual(retried.pages.flatMap((page) => page.added.map((transaction) => transaction.transaction_id)), ['tx-1', 'tx-2'])
  assert.equal(retried.cursor, 'cursor-2')
})

test('repeated page cursor is rejected rather than looping or claiming progress', async () => {
  const plaidClient = { transactionsSync: async () => ({ data: { ...pageFor(1, true), next_cursor: null } }) }
  await assert.rejects(
    fetchPlaidTransactionBatch({ plaidClient, accessToken: 'synthetic-token', cursor: null }),
    /invalid transactions page|cursor did not advance/i,
  )
})

