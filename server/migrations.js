const schemaMigrations = [
  {
    version: 1,
    name: 'baseline-schema-and-current-upgrades',
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          google_sub TEXT UNIQUE,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS financial_profiles (
          user_id INTEGER PRIMARY KEY,
          monthly_income INTEGER NOT NULL DEFAULT 0,
          current_money INTEGER NOT NULL DEFAULT 0,
          fixed_expenses INTEGER NOT NULL DEFAULT 0,
          planned_spending INTEGER NOT NULL DEFAULT 0,
          savings_allocation INTEGER NOT NULL DEFAULT 0,
          tracking_mode TEXT NOT NULL DEFAULT 'Hybrid',
          focus_areas TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          category TEXT NOT NULL,
          due_label TEXT NOT NULL,
          priority TEXT NOT NULL,
          completed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS goals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          current_amount INTEGER NOT NULL DEFAULT 0,
          target_amount INTEGER NOT NULL DEFAULT 0,
          due_date TEXT NOT NULL,
          contribution TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          description TEXT NOT NULL,
          amount INTEGER NOT NULL,
          category TEXT NOT NULL,
          type TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS bills (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          amount INTEGER NOT NULL DEFAULT 0,
          frequency TEXT NOT NULL DEFAULT 'Monthly',
          due_date TEXT NOT NULL,
          category TEXT NOT NULL,
          is_fixed INTEGER NOT NULL DEFAULT 1,
          is_estimated INTEGER NOT NULL DEFAULT 0,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS incomes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          source TEXT NOT NULL,
          amount INTEGER NOT NULL DEFAULT 0,
          frequency TEXT NOT NULL DEFAULT 'Monthly',
          next_date TEXT NOT NULL,
          is_variable INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          merchant TEXT NOT NULL,
          amount INTEGER NOT NULL DEFAULT 0,
          frequency TEXT NOT NULL DEFAULT 'Monthly',
          next_date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'Active',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          balance REAL NOT NULL DEFAULT 0,
          plaid_account_id TEXT,
          plaid_item_id TEXT,
          mask TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS bank_connections (
          item_id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          institution_name TEXT NOT NULL,
          encrypted_access_token TEXT NOT NULL,
          encryption_iv TEXT NOT NULL,
          encryption_tag TEXT NOT NULL,
          cursor TEXT,
          status TEXT NOT NULL DEFAULT 'connected',
          last_synced_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS user_notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          event TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          read_at TEXT,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS notification_emails (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          recipient TEXT NOT NULL,
          subject TEXT NOT NULL,
          message TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT DEFAULT CURRENT_TIMESTAMP,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS billing_subscriptions (
          user_id INTEGER PRIMARY KEY,
          stripe_customer_id TEXT UNIQUE,
          checkout_session_id TEXT,
          stripe_subscription_id TEXT UNIQUE,
          status TEXT NOT NULL DEFAULT 'free',
          price_id TEXT,
          current_period_end TEXT,
          stripe_event_created INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS stripe_webhook_events (
          event_id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          event_created INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'failed')),
          attempted_at INTEGER NOT NULL,
          processed_at TEXT
        );
      `)
      db.prepare("UPDATE notification_emails SET status = 'queued' WHERE status = 'sending'").run()
      const userColumns = new Set(db.pragma('table_info(users)').map((column) => column.name))
      if (!userColumns.has('session_version')) db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0')
      if (!userColumns.has('email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1')
      db.exec(`CREATE TABLE IF NOT EXISTS auth_tokens (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')), expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE); CREATE INDEX IF NOT EXISTS auth_tokens_user_purpose_idx ON auth_tokens(user_id, purpose);`)
      if (!userColumns.has('google_sub')) {
        db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT')
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique ON users(google_sub) WHERE google_sub IS NOT NULL')
      }
      const accountColumns = new Set(db.pragma('table_info(accounts)').map((column) => column.name))
      for (const [column, definition] of [
        ['plaid_account_id', 'TEXT'],
        ['plaid_item_id', 'TEXT'],
        ['mask', 'TEXT'],
        ['updated_at', 'TEXT'],
      ]) {
        if (!accountColumns.has(column)) db.exec(`ALTER TABLE accounts ADD COLUMN ${column} ${definition}`)
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS accounts_plaid_account_unique ON accounts(plaid_account_id) WHERE plaid_account_id IS NOT NULL')
      const transactionColumns = new Set(db.pragma('table_info(transactions)').map((column) => column.name))
      if (!transactionColumns.has('source')) db.exec("ALTER TABLE transactions ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
      if (!transactionColumns.has('provider_transaction_id')) db.exec('ALTER TABLE transactions ADD COLUMN provider_transaction_id TEXT')
      if (!transactionColumns.has('account_id')) db.exec('ALTER TABLE transactions ADD COLUMN account_id INTEGER')
      if (!transactionColumns.has('plaid_item_id')) db.exec('ALTER TABLE transactions ADD COLUMN plaid_item_id TEXT')
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS transactions_provider_id_unique ON transactions(provider_transaction_id) WHERE provider_transaction_id IS NOT NULL')
      const billingColumns = new Set(db.pragma('table_info(billing_subscriptions)').map((column) => column.name))
      if (!billingColumns.has('checkout_session_id')) {
        db.exec('ALTER TABLE billing_subscriptions ADD COLUMN checkout_session_id TEXT')
      }
      if (!billingColumns.has('stripe_event_created')) {
        db.exec('ALTER TABLE billing_subscriptions ADD COLUMN stripe_event_created INTEGER NOT NULL DEFAULT 0')
      }

    },
  },
]

export const migrateDatabase = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)

  return db.transaction(() => {
    const appliedVersions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(({ version }) => Number(version))
    for (let index = 0; index < appliedVersions.length; index += 1) {
      if (appliedVersions[index] !== index + 1) {
        throw new Error('Database migration history is incomplete or out of order.')
      }
    }
    let currentVersion = appliedVersions.length
    const latestVersion = schemaMigrations.at(-1)?.version || 0
    if (currentVersion > latestVersion) {
      throw new Error('Database schema is newer than this application version.')
    }
    for (const migration of schemaMigrations) {
      if (migration.version <= currentVersion) continue
      if (migration.version !== currentVersion + 1) {
        throw new Error(`Database migration sequence is incomplete before version ${migration.version}.`)
      }
      migration.apply(db)
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name)
      currentVersion = migration.version
    }
    return currentVersion
  })()
}
