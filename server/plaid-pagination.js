/** Fetch one bounded, resumable batch of Plaid transaction changes. */
export async function fetchPlaidTransactionBatch({ plaidClient, accessToken, cursor, maxPages = 10 }) {
  const pages = []
  let nextCursor = cursor
  let hasMore = false

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const response = await plaidClient.transactionsSync({
      access_token: accessToken,
      ...(nextCursor ? { cursor: nextCursor } : {}),
      count: 500,
    })
    const page = response.data
    if (!page || !Array.isArray(page.added) || !Array.isArray(page.modified) || !Array.isArray(page.removed)
      || typeof page.next_cursor !== 'string' || typeof page.has_more !== 'boolean') {
      throw new Error('Plaid returned an invalid transactions page.')
    }
    if (page.next_cursor === nextCursor && page.has_more) {
      throw new Error('Plaid pagination cursor did not advance.')
    }
    pages.push(page)
    nextCursor = page.next_cursor
    hasMore = page.has_more
    if (!hasMore) break
  }

  return { pages, cursor: nextCursor, hasMore }
}

