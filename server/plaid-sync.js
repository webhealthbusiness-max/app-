export const createPlaidSync = ({ db, plaidClient, decryptBankAccessToken, sanitizeText }) => {
  const activeBankSyncs = new Map()
  const syncPlaidConnection = (connection) => {
    if (activeBankSyncs.has(connection.item_id)) return activeBankSyncs.get(connection.item_id)
    const sync = (async () => {
      if (!plaidClient) throw new Error('Bank connections are not configured.')
      const accessToken = decryptBankAccessToken(connection)
      let cursor = connection.cursor
      let pageCount = 0
      let hasMore = false
      const changes = []
      do {
        const response = await plaidClient.transactionsSync({
          access_token: accessToken,
          ...(cursor ? { cursor } : {}),
          count: 500,
        })
        const page = response.data
        changes.push(page)
        cursor = page.next_cursor
        hasMore = page.has_more
        pageCount += 1
      } while (hasMore && pageCount < 10)
  
      const accountResponse = await plaidClient.accountsGet({ access_token: accessToken })
      const addOrUpdateTransaction = db.prepare(`
        INSERT INTO transactions (
          user_id, description, amount, category, type, created_at,
          source, provider_transaction_id, account_id, plaid_item_id
        ) VALUES (?, ?, ?, ?, ?, ?, 'bank', ?, ?, ?)
        ON CONFLICT(provider_transaction_id) DO UPDATE SET
          description = excluded.description,
          amount = excluded.amount,
          category = excluded.category,
          type = excluded.type,
          created_at = excluded.created_at,
          account_id = excluded.account_id,
          plaid_item_id = excluded.plaid_item_id
        WHERE transactions.user_id = excluded.user_id
      `)
      const findAccountId = db.prepare('SELECT id FROM accounts WHERE plaid_account_id = ? AND user_id = ?')
      const deleteTransaction = db.prepare("DELETE FROM transactions WHERE user_id = ? AND source = 'bank' AND provider_transaction_id = ?")
      const removePendingTransaction = db.prepare("DELETE FROM transactions WHERE user_id = ? AND source = 'bank' AND provider_transaction_id = ?")
      const upsertAccount = db.prepare(`
        INSERT INTO accounts (user_id, name, type, balance, plaid_account_id, plaid_item_id, mask)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plaid_account_id) WHERE plaid_account_id IS NOT NULL DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          balance = COALESCE(excluded.balance, accounts.balance),
          plaid_item_id = excluded.plaid_item_id,
            mask = excluded.mask,
            updated_at = CURRENT_TIMESTAMP
        WHERE accounts.user_id = excluded.user_id
      `)
      let addedCount = 0
      let modifiedCount = 0
      db.transaction(() => {
        for (const account of accountResponse.data.accounts) {
          upsertAccount.run(
            connection.user_id,
            sanitizeText(account.name, 'Bank account').slice(0, 100),
            `${account.type}${account.subtype ? ` · ${account.subtype}` : ''}`.slice(0, 80),
            account.balances.current ?? 0,
            account.account_id,
            connection.item_id,
            account.mask || null,
          )
        }
        for (const page of changes) {
          for (const transaction of page.added) {
            if (transaction.pending_transaction_id) {
              removePendingTransaction.run(connection.user_id, transaction.pending_transaction_id)
            }
            const localAccount = findAccountId.get(transaction.account_id, connection.user_id)
            const category = transaction.personal_finance_category?.primary
              ?.replaceAll('_', ' ')
              ?.toLowerCase()
              ?.replace(/\b\w/g, (character) => character.toUpperCase())
              || transaction.category?.[0]
              || 'Other'
            const transactionType = transaction.personal_finance_category?.primary?.startsWith('TRANSFER_')
              ? 'Transfer'
              : transaction.amount > 0 ? 'Expense' : 'Income'
            const description = sanitizeText(transaction.merchant_name || transaction.name, 'Bank transaction').slice(0, 160)
            addOrUpdateTransaction.run(
              connection.user_id,
              description,
              Math.abs(transaction.amount),
              category.slice(0, 80),
              transactionType,
              transaction.date,
              transaction.transaction_id,
              localAccount?.id || null,
              connection.item_id,
            )
            addedCount += 1
          }
          for (const transaction of page.modified) {
            const localAccount = findAccountId.get(transaction.account_id, connection.user_id)
            const category = transaction.personal_finance_category?.primary
              ?.replaceAll('_', ' ')
              ?.toLowerCase()
              ?.replace(/\b\w/g, (character) => character.toUpperCase())
              || transaction.category?.[0]
              || 'Other'
            const transactionType = transaction.personal_finance_category?.primary?.startsWith('TRANSFER_')
              ? 'Transfer'
              : transaction.amount > 0 ? 'Expense' : 'Income'
            addOrUpdateTransaction.run(
              connection.user_id,
              sanitizeText(transaction.merchant_name || transaction.name, 'Bank transaction').slice(0, 160),
              Math.abs(transaction.amount),
              category.slice(0, 80),
              transactionType,
              transaction.date,
              transaction.transaction_id,
              localAccount?.id || null,
              connection.item_id,
            )
            modifiedCount += 1
          }
          for (const transaction of page.removed) {
            if (transaction.transaction_id) deleteTransaction.run(connection.user_id, transaction.transaction_id)
          }
        }
        db.prepare(`
          UPDATE bank_connections
          SET cursor = ?, status = 'connected', last_synced_at = CURRENT_TIMESTAMP
          WHERE item_id = ? AND user_id = ?
        `).run(cursor, connection.item_id, connection.user_id)
      })()
      return { addedCount, modifiedCount, complete: !hasMore }
    })().finally(() => activeBankSyncs.delete(connection.item_id))
    activeBankSyncs.set(connection.item_id, sync)
    return sync
  }
  
    return syncPlaidConnection
}
