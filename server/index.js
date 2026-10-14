import express from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import Stripe from 'stripe'
import nodemailer from 'nodemailer'
import { OAuth2Client } from 'google-auth-library'
import { Configuration, PlaidApi, PlaidEnvironments, Products } from 'plaid'
import Database from 'better-sqlite3'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const port = Number(process.env.PORT || 4000)
const isProduction = process.env.NODE_ENV === 'production'
if (isProduction && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error('A JWT_SECRET of at least 32 characters is required in production.')
}
if (isProduction && !process.env.ALLOWED_ORIGINS) {
  throw new Error('ALLOWED_ORIGINS must be explicitly configured in production.')
}
if (isProduction && !process.env.DATABASE_PATH) {
  throw new Error('DATABASE_PATH must point to a persistent production data volume.')
}
if (isProduction && (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET || !process.env.STRIPE_PRICE_MONTHLY || !process.env.STRIPE_PRICE_ANNUAL || !process.env.APP_BASE_URL)) {
  throw new Error('Stripe keys, monthly and annual price IDs, and APP_BASE_URL are required in production.')
}
if (isProduction && (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.SMTP_FROM)) {
  throw new Error('SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM are required in production.')
}
if (['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'].some((key) => process.env[key]) && !['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'].every((key) => process.env[key])) {
  throw new Error('Configure SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM together.')
}
if (process.env.SMTP_PORT && (!Number.isInteger(Number(process.env.SMTP_PORT)) || Number(process.env.SMTP_PORT) < 1 || Number(process.env.SMTP_PORT) > 65535)) {
  throw new Error('SMTP_PORT must be an integer between 1 and 65535.')
}
const plaidConfigValues = [process.env.PLAID_CLIENT_ID, process.env.PLAID_SECRET, process.env.BANK_TOKEN_ENCRYPTION_KEY]
const plaidConfigured = plaidConfigValues.every(Boolean)
if (plaidConfigValues.some(Boolean) && !plaidConfigured) {
  throw new Error('Configure PLAID_CLIENT_ID, PLAID_SECRET, and BANK_TOKEN_ENCRYPTION_KEY together.')
}
const plaidEnvironment = process.env.PLAID_ENV || 'sandbox'
if (!['sandbox', 'development', 'production'].includes(plaidEnvironment)) {
  throw new Error('PLAID_ENV must be sandbox, development, or production.')
}
if (plaidConfigured && !/^[a-fA-F0-9]{64}$/.test(process.env.BANK_TOKEN_ENCRYPTION_KEY)) {
  throw new Error('BANK_TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).')
}
if (isProduction && plaidConfigured && plaidEnvironment !== 'production') {
  throw new Error('Production bank connections must use PLAID_ENV=production.')
}
if (process.env.PLAID_REDIRECT_URI) {
  let plaidRedirectUrl
  try {
    plaidRedirectUrl = new URL(process.env.PLAID_REDIRECT_URI)
  } catch {
    throw new Error('PLAID_REDIRECT_URI must be a valid absolute URL.')
  }
  if (isProduction && plaidRedirectUrl.protocol !== 'https:') {
    throw new Error('Production PLAID_REDIRECT_URI must use HTTPS.')
  }
}
if (isProduction && !process.env.STRIPE_SECRET_KEY.startsWith('sk_live_')) {
  throw new Error('Production billing must use a live Stripe secret key.')
}
const databasePath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, '..', 'data', 'grounded.db')
mkdirSync(path.dirname(databasePath), { recursive: true })
const db = new Database(databasePath)
db.pragma('foreign_keys = ON')
db.pragma('journal_mode = WAL')
const JWT_SECRET = process.env.JWT_SECRET || (isProduction ? '' : 'grounded-dev-secret')
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null
const googleClientId = process.env.GOOGLE_CLIENT_ID || ''
const googleClient = googleClientId ? new OAuth2Client(googleClientId) : null
const plaidClient = plaidConfigured
  ? new PlaidApi(new Configuration({
      basePath: PlaidEnvironments[plaidEnvironment],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
          'PLAID-SECRET': process.env.PLAID_SECRET,
        },
      },
    }))
  : null
const bankTokenEncryptionKey = plaidConfigured ? Buffer.from(process.env.BANK_TOKEN_ENCRYPTION_KEY, 'hex') : null
const logPlaidFailure = (context, error) => {
  console.error(context, error?.response?.data?.error_code || error?.code || 'Unknown Plaid error')
}
const emailTransport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      requireTLS: Number(process.env.SMTP_PORT || 587) !== 465,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 30000,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null
const emailFrom = process.env.SMTP_FROM || ''
const stripePrices = {
  monthly: process.env.STRIPE_PRICE_MONTHLY || '',
  annual: process.env.STRIPE_PRICE_ANNUAL || '',
}
const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:3000'
if (isProduction) {
  let parsedAppBaseUrl
  try {
    parsedAppBaseUrl = new URL(appBaseUrl)
  } catch {
    throw new Error('APP_BASE_URL must be a valid absolute URL.')
  }
  if (parsedAppBaseUrl.protocol !== 'https:' || ['localhost', '127.0.0.1'].includes(parsedAppBaseUrl.hostname)) {
    throw new Error('Production APP_BASE_URL must use HTTPS and cannot be localhost.')
  }
}
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000)
const RATE_LIMITS = { signup: 5, login: 10 }
if (!Number.isInteger(RATE_LIMIT_WINDOW_MS) || RATE_LIMIT_WINDOW_MS < 1000 || RATE_LIMIT_WINDOW_MS > 3600000) {
  throw new Error('RATE_LIMIT_WINDOW_MS must be an integer between 1000 and 3600000.')
}
const requestBuckets = new Map()
const appStartTime = Date.now()
const MAX_RATE_LIMIT_BUCKETS = 10000

const sanitizeText = (value, fallback = '') => {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || fallback
}

const parseCurrency = (value) => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000000) {
    return null
  }
  return parsed
}

const isValidEmail = (value) => (
  value.length <= 254
  && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
)

const getRateLimitKey = (req, prefix) => `${prefix}:${req.ip || req.headers['x-forwarded-for'] || 'unknown'}`

const enforceRateLimit = (req, prefix, maxRequests) => {
  const key = getRateLimitKey(req, prefix)
  const now = Date.now()
  if (requestBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
    for (const [bucketKey, bucket] of requestBuckets) {
      if (bucket.resetAt <= now) requestBuckets.delete(bucketKey)
    }
    if (requestBuckets.size >= MAX_RATE_LIMIT_BUCKETS && !requestBuckets.has(key)) {
      return false
    }
  }
  const current = requestBuckets.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }

  if (now > current.resetAt) {
    current.count = 0
    current.resetAt = now + RATE_LIMIT_WINDOW_MS
  }

  if (current.count >= maxRequests) {
    requestBuckets.set(key, current)
    return false
  }

  current.count += 1
  requestBuckets.set(key, current)
  return true
}

const renderLegalPage = (pageKey, page) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${page.title} | Grounded</title>
    <style>
      :root {
        --sage-primary: #78967f;
        --sage-deep: #1d2822;
        --sage-soft: #a9c0a8;
        --cream: #f5f3ec;
        --text: #1d2822;
        --muted: #68706a;
        --card: rgba(255,255,255,0.8);
        --border: rgba(120,150,127,0.18);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, Arial, sans-serif;
        background: linear-gradient(180deg, #f5f3ec 0%, #edf3ee 100%);
        color: var(--text);
      }
      main {
        max-width: 860px;
        margin: 64px auto;
        padding: 32px;
        border-radius: 28px;
        background: var(--card);
        border: 1px solid var(--border);
        box-shadow: 0 20px 38px rgba(29,40,34,0.08);
      }
      .eyebrow {
        display: inline-block;
        background: rgba(120,150,127,0.12);
        color: var(--sage-deep);
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        font-weight: 700;
      }
      h1 {
        margin: 18px 0 10px;
        font-size: clamp(2rem, 4vw, 3rem);
      }
      p {
        color: var(--muted);
        line-height: 1.7;
      }
      ul {
        color: var(--muted);
        line-height: 1.7;
        padding-left: 20px;
      }
      .status {
        font-size: 0.9rem;
        color: var(--muted);
        margin-bottom: 18px;
      }
      a {
        color: var(--sage-deep);
      }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">Grounded</div>
      <h1>${page.title}</h1>
      <p class="status">Draft informational page for product, engineering, and legal review before production launch.</p>
      <p>${page.summary}</p>
      <ul>
        ${page.sections.map((section) => `<li>${section}</li>`).join('')}
      </ul>
      <p>For a live app experience, use the Privacy Center and account settings inside Grounded. This page is designed to document the product’s intended approach to privacy, terms, and copyright review.</p>
      <p><a href="/">Back to Grounded</a></p>
    </main>
  </body>
</html>`

const publicLegalPages = {
  privacy: {
    title: 'Privacy Policy',
    summary: 'This is a pre-launch privacy disclosure for a manually entered finance-planning MVP. It is not a complete production privacy policy.',
    sections: [
      'The app stores account details and financial values that a user manually enters so it can provide account and planning screens. Manual account entries do not connect to a financial institution or include bank credentials.',
      'If enabled and authorized by the user, Plaid retrieves selected financial account balances and transaction history for categorization. Grounded stores imported transaction details and encrypted Plaid access tokens to provide syncing. Users can disconnect an Item and delete their account to request provider and local data removal.',
      'If enabled, Google Identity Services verifies sign-in credentials and Grounded receives the verified email address, display name, and stable Google account identifier. Grounded does not receive the Google password.',
      'Grounded records in-app account/security notifications and, when SMTP email is configured, sends alerts for account creation, sign-ins, manual account additions, account deletion, and subscription status changes. Pending email delivery records temporarily retain the recipient email address until delivery or final retry.',
      'If a user purchases Plus, Stripe processes payment details. Grounded stores Stripe customer/subscription identifiers and subscription status, not full payment card numbers.',
      'Users can request a JSON export or delete their account through the authenticated Privacy Center.',
      'This MVP does not yet have a production retention schedule, backup-erasure policy, or independent privacy compliance review.',
      'Do not enter real financial data until production hosting, storage protection, retention, backups, and applicable legal requirements have been reviewed.',
    ],
  },
  terms: {
    title: 'Terms of Use',
    summary: 'Grounded provides informational, organizational, and educational financial tools and forecasts.',
    sections: [
      'Eligibility: users must be authorized to create and manage their own financial accounts and data.',
      'Acceptable use: no abuse, no illegal activity, no deceptive financial actions, and no attempts to access another user’s data.',
      'Financial information is informational only; Grounded does not guarantee future outcomes.',
      'Financial institution connections, when enabled, are provided by Plaid and only access data the user authorizes. Grounded does not initiate payments or move money. The app does not provide financial, tax, or legal advice.',
      'Grounded Plus is a recurring paid subscription at the price shown at checkout. Subscriptions continue until canceled through the billing portal; applicable taxes and any available refund terms are presented during checkout and must be confirmed before launch.',
      'These draft terms have not been reviewed by qualified counsel and must be replaced or approved before a public launch.',
    ],
  },
  copyright: {
    title: 'Copyright & IP Reporting',
    summary: 'Grounded respects intellectual property rights and maintains a review process for reported concerns.',
    sections: [
      'Reporters should provide copyright ownership details, the allegedly infringing material, and a clear description of where it appears.',
      'Reports are reviewed by internal staff through a documented process before any content change is made.',
      'Grounded does not automatically remove content without a review-based process and may contact the reporter for more information.',
    ],
  },
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:3003,http://localhost:4173').split(',').map((origin) => origin.trim()).filter(Boolean)
if (isProduction && allowedOrigins.some((origin) => origin.includes('localhost'))) {
  throw new Error('Production ALLOWED_ORIGINS cannot include localhost.')
}

const configuredTrustProxy = process.env.TRUST_PROXY_HOPS
if (configuredTrustProxy !== undefined) {
  const trustedHops = Number(configuredTrustProxy)
  if (!Number.isInteger(trustedHops) || trustedHops < 1 || trustedHops > 5) {
    throw new Error('TRUST_PROXY_HOPS must be an integer from 1 to 5.')
  }
  app.set('trust proxy', trustedHops)
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
      return
    }
    callback(new Error('Origin not allowed by CORS policy.'))
  },
  credentials: true,
}))
app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res, next) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Subscription billing is not configured.' })
  }
  const signature = req.headers['stripe-signature']
  if (typeof signature !== 'string') {
    return res.status(400).json({ error: 'Missing Stripe signature.' })
  }

  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (error) {
    return res.status(400).json({ error: 'Invalid Stripe webhook signature.' })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      if (session.mode === 'subscription' && session.subscription) {
        const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id
        const subscription = await stripe.subscriptions.retrieve(subscriptionId)
        const userId = Number(session.metadata?.userId || subscription.metadata?.userId)
        if (Number.isInteger(userId) && userId > 0) {
          persistStripeSubscription(userId, session.customer, subscription)
        }
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object
      const user = db.prepare('SELECT user_id FROM billing_subscriptions WHERE stripe_customer_id = ?')
        .get(typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id)
      const userId = Number(subscription.metadata?.userId || user?.user_id)
      if (Number.isInteger(userId) && userId > 0) {
        persistStripeSubscription(userId, subscription.customer, subscription)
      }
    }
    return res.json({ received: true })
  } catch (error) {
    return next(error)
  }
})
app.use(express.json({ limit: '1mb' }))
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store')
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  next()
})

const createUserToken = (user) => jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' })
const hashAuthToken = (token) => createHash('sha256').update(token).digest('hex')

const withUser = (req, res, next) => {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' })
  }

  let decoded
  try {
    decoded = jwt.verify(token, JWT_SECRET)
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.NotBeforeError) {
      return res.status(401).json({ error: 'Session expired or invalid.' })
    }
    return next(error)
  }
  if (!decoded || typeof decoded !== 'object' || !Number.isInteger(decoded.id)) {
    return res.status(401).json({ error: 'Invalid user session.' })
  }
  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(decoded.id)
  if (!user) return res.status(401).json({ error: 'Invalid user session.' })
  const tokenHash = hashAuthToken(token)
  const revoked = db.prepare('SELECT 1 FROM revoked_tokens WHERE token_hash = ? AND expires_at > ?').get(tokenHash, Date.now())
  if (revoked) return res.status(401).json({ error: 'Session has been revoked. Please log in again.' })
  req.user = user
  req.authTokenHash = tokenHash
  req.authTokenExpiresAt = decoded.exp * 1000
  return next()
}

const defaultProfile = {
  monthlyIncome: 0,
  currentMoney: 0,
  fixedExpenses: 0,
  plannedSpending: 0,
  savingsAllocation: 0,
  trackingMode: 'Manual',
  focusAreas: JSON.stringify([]),
}

const createUserSeedData = (userId) => {
  const profile = db.prepare(`
    INSERT INTO financial_profiles (user_id, monthly_income, current_money, fixed_expenses, planned_spending, savings_allocation, tracking_mode, focus_areas)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  profile.run(
    userId,
    defaultProfile.monthlyIncome,
    defaultProfile.currentMoney,
    defaultProfile.fixedExpenses,
    defaultProfile.plannedSpending,
    defaultProfile.savingsAllocation,
    defaultProfile.trackingMode,
    defaultProfile.focusAreas,
  )

}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    google_sub TEXT UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS revoked_tokens (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
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
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`) 
db.prepare("UPDATE notification_emails SET status = 'queued' WHERE status = 'sending'").run()
const userColumns = new Set(db.pragma('table_info(users)').map((column) => column.name))
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

const encryptBankAccessToken = (accessToken) => {
  if (!bankTokenEncryptionKey) throw new Error('Bank token encryption is not configured.')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', bankTokenEncryptionKey, iv)
  const encrypted = Buffer.concat([cipher.update(accessToken, 'utf8'), cipher.final()])
  return {
    encryptedAccessToken: encrypted.toString('base64'),
    encryptionIv: iv.toString('base64'),
    encryptionTag: cipher.getAuthTag().toString('base64'),
  }
}

const decryptBankAccessToken = (connection) => {
  if (!bankTokenEncryptionKey) throw new Error('Bank token encryption is not configured.')
  const decipher = createDecipheriv('aes-256-gcm', bankTokenEncryptionKey, Buffer.from(connection.encryption_iv, 'base64'))
  decipher.setAuthTag(Buffer.from(connection.encryption_tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(connection.encrypted_access_token, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

const notifyUser = (user, event, title, message, emailMessage = message) => {
  db.prepare('INSERT INTO user_notifications (user_id, event, title, message) VALUES (?, ?, ?, ?)')
    .run(user.id, event, title, message)
  if (emailTransport) {
    db.prepare(`
      INSERT INTO notification_emails (user_id, recipient, subject, message)
      VALUES (?, ?, ?, ?)
    `).run(user.id, user.email, `Grounded security alert: ${title}`, emailMessage)
    void deliverQueuedEmails()
  }
}

let sendingNotificationEmails = false
const deliverQueuedEmails = async () => {
  if (!emailTransport || sendingNotificationEmails) return
  sendingNotificationEmails = true
  try {
    const queued = db.prepare(`
      SELECT id, recipient, subject, message, attempts
      FROM notification_emails
      WHERE status = 'queued' AND next_attempt_at <= CURRENT_TIMESTAMP
      ORDER BY created_at ASC
      LIMIT 10
    `).all()
    for (const email of queued) {
      db.prepare('UPDATE notification_emails SET status = ? WHERE id = ? AND status = ?')
        .run('sending', email.id, 'queued')
      try {
        await emailTransport.sendMail({ from: emailFrom, to: email.recipient, subject: email.subject, text: email.message })
        db.prepare('DELETE FROM notification_emails WHERE id = ?').run(email.id)
      } catch (error) {
        const attempts = email.attempts + 1
        if (attempts >= 5) {
          db.prepare('DELETE FROM notification_emails WHERE id = ?').run(email.id)
          console.error('Notification email permanently failed:', error?.code || error?.message || 'Unknown SMTP error')
        } else {
          const retryAfterMinutes = 2 ** attempts
          db.prepare(`
            UPDATE notification_emails
            SET status = 'queued', attempts = ?, next_attempt_at = datetime('now', ?)
            WHERE id = ?
          `).run(attempts, `+${retryAfterMinutes} minutes`, email.id)
          console.error('Notification email delivery failed; it will be retried:', error?.code || error?.message || 'Unknown SMTP error')
        }
      }
    }
  } finally {
    sendingNotificationEmails = false
  }
}
const notificationEmailTimer = setInterval(() => { void deliverQueuedEmails() }, 30000)
notificationEmailTimer.unref()

const persistStripeSubscription = (userId, customer, subscription) => {
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return
  const previousStatus = db.prepare('SELECT status FROM billing_subscriptions WHERE user_id = ?').get(userId)?.status
  const customerId = typeof customer === 'string' ? customer : customer?.id
  const priceId = subscription.items?.data?.[0]?.price?.id || null
  const currentPeriodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null
  db.prepare(`
    INSERT INTO billing_subscriptions (user_id, stripe_customer_id, checkout_session_id, stripe_subscription_id, status, price_id, current_period_end)
    VALUES (?, ?, NULL, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      stripe_customer_id = excluded.stripe_customer_id,
      checkout_session_id = NULL,
      stripe_subscription_id = excluded.stripe_subscription_id,
      status = excluded.status,
      price_id = excluded.price_id,
      current_period_end = excluded.current_period_end,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, customerId || null, subscription.id, subscription.status, priceId, currentPeriodEnd)
  if (previousStatus !== subscription.status) {
    const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId)
    if (user) {
      notifyUser(
        user,
        'billing',
        'Subscription updated',
        `Your Grounded plan status is now ${subscription.status}.`,
        `Your Grounded plan status is now ${subscription.status}. If you did not expect this change, review billing in your account.`,
      )
    }
  }
}

const getBillingStatus = (userId) => {
  const record = db.prepare('SELECT status, price_id AS priceId, current_period_end AS currentPeriodEnd FROM billing_subscriptions WHERE user_id = ?')
    .get(userId)
  const premium = record?.status === 'active' || record?.status === 'trialing'
  return {
    plan: premium ? 'plus' : 'free',
    status: record?.status || 'free',
    priceId: record?.priceId || null,
    currentPeriodEnd: record?.currentPeriodEnd || null,
    prices: { monthly: 5.99, annual: 59.99 },
  }
}

const requirePlus = (req, res, next) => {
  if (!['active', 'trialing'].includes(getBillingStatus(req.user.id).status)) {
    return res.status(402).json({ error: 'Grounded Plus is required for this feature.', code: 'PLUS_REQUIRED' })
  }
  return next()
}

app.post('/api/auth/signup', (req, res) => {
  const { name, email, password } = req.body || {}
  if (!enforceRateLimit(req, 'signup', RATE_LIMITS.signup)) {
    return res.status(429).json({ error: 'Too many sign-up attempts. Please wait a moment and try again.' })
  }

  const safeName = sanitizeText(name)
  const safeEmail = sanitizeText(email).toLowerCase()
  const safePassword = String(password || '')

  if (
    !safeName
    || safeName.length > 80
    || !isValidEmail(safeEmail)
    || safePassword.length < 12
    || Buffer.byteLength(safePassword, 'utf8') > 72
  ) {
    return res.status(400).json({ error: 'Name (up to 80 characters), valid email, and a password of 12–72 bytes are required.' })
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(safeEmail)
  if (existing) {
    return res.status(409).json({ error: 'A user already exists with this email.' })
  }

  const passwordHash = bcrypt.hashSync(safePassword, 12)
  const user = db.transaction(() => {
    const result = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .run(safeName, safeEmail, passwordHash)
    createUserSeedData(result.lastInsertRowid)
    return db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(result.lastInsertRowid)
  })()
  notifyUser(
    user,
    'account_created',
    'Welcome to Grounded',
    'Your Grounded account was created. You can review account activity in Notifications.',
    `Hi ${user.name},\n\nYour Grounded account was created successfully. You can review account activity in your in-app Notifications.\n\nIf you did not create this account, please contact support.`,
  )
  return res.status(201).json({ token: createUserToken(user), user })
})

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {}
  if (!enforceRateLimit(req, 'login', RATE_LIMITS.login)) {
    return res.status(429).json({ error: 'Too many login attempts. Please wait a moment and try again.' })
  }

  const safeEmail = sanitizeText(email).toLowerCase()
  const safePassword = String(password || '')

  if (!isValidEmail(safeEmail) || !safePassword || Buffer.byteLength(safePassword, 'utf8') > 72) {
    return res.status(400).json({ error: 'Email and password are required.' })
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(safeEmail)
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password.' })
  }

  const valid = bcrypt.compareSync(safePassword, user.password_hash)
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password.' })
  }

  const safeUser = { id: user.id, name: user.name, email: user.email }
  notifyUser(
    safeUser,
    'sign_in',
    'New sign-in',
    'Your Grounded account was just accessed with your email and password.',
    `A sign-in to your Grounded account was completed at ${new Date().toUTCString()} using email and password. If this was not you, change your password and contact support.`,
  )
  return res.json({ token: createUserToken(safeUser), user: safeUser })
})

app.post('/api/auth/logout', withUser, (req, res) => {
  db.prepare('DELETE FROM revoked_tokens WHERE expires_at <= ?').run(Date.now())
  db.prepare('INSERT OR REPLACE INTO revoked_tokens (token_hash, expires_at) VALUES (?, ?)')
    .run(req.authTokenHash, req.authTokenExpiresAt)
  return res.json({ success: true })
})

app.post('/api/auth/google', async (req, res, next) => {
  if (!googleClient || !enforceRateLimit(req, 'google-login', 10)) {
    return res.status(googleClient ? 429 : 503).json({
      error: googleClient ? 'Too many Google sign-in attempts. Please wait and try again.' : 'Google sign-in is not configured yet.',
    })
  }
  const credential = req.body?.credential
  if (typeof credential !== 'string' || credential.length > 10000) {
    return res.status(400).json({ error: 'A valid Google sign-in credential is required.' })
  }

  try {
    let ticket
    try {
      ticket = await googleClient.verifyIdToken({ idToken: credential, audience: googleClientId })
    } catch {
      return res.status(401).json({ error: 'Google sign-in credential is invalid or expired.' })
    }
    const claims = ticket.getPayload()
    if (!claims?.sub || !claims.email || claims.email_verified !== true) {
      return res.status(401).json({ error: 'Google could not verify this email address.' })
    }
    const safeEmail = claims.email.trim().toLowerCase()
    if (!isValidEmail(safeEmail)) {
      return res.status(401).json({ error: 'Google returned an invalid email address.' })
    }

    let user = db.prepare('SELECT id, name, email, google_sub AS googleSub FROM users WHERE google_sub = ?').get(claims.sub)
    let created = false
    if (!user) {
      user = db.prepare('SELECT id, name, email, google_sub AS googleSub FROM users WHERE email = ?').get(safeEmail)
      if (user) {
        db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(claims.sub, user.id)
      } else {
        const safeName = sanitizeText(claims.name, safeEmail.split('@')[0]).slice(0, 80)
        user = db.transaction(() => {
          const result = db.prepare('INSERT INTO users (name, email, password_hash, google_sub) VALUES (?, ?, ?, ?)')
            .run(safeName, safeEmail, bcrypt.hashSync(randomBytes(32).toString('hex'), 12), claims.sub)
          createUserSeedData(result.lastInsertRowid)
          return db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(result.lastInsertRowid)
        })()
        created = true
      }
    }

    const safeUser = { id: user.id, name: user.name, email: user.email }
    notifyUser(
      safeUser,
      created ? 'account_created' : 'sign_in',
      created ? 'Welcome to Grounded' : 'New Google sign-in',
      created ? 'Your Grounded account was created with Google.' : 'Your Grounded account was just accessed with Google.',
      created
        ? `Hi ${safeUser.name},\n\nYour Grounded account was created with Google. You can review account activity in your in-app Notifications.\n\nIf you did not create this account, contact support.`
        : `A Google sign-in to your Grounded account was completed at ${new Date().toUTCString()}. If this was not you, review your Google account security and contact support.`,
    )
    return res.json({ token: createUserToken(safeUser), user: safeUser, newUser: created })
  } catch (error) {
    return next(error)
  }
})

const getProfile = (userId) => {
  const row = db.prepare(`
    SELECT monthly_income AS monthlyIncome, current_money AS currentMoney, fixed_expenses AS fixedExpenses,
           planned_spending AS plannedSpending, savings_allocation AS savingsAllocation,
           tracking_mode AS trackingMode, focus_areas AS focusAreas
    FROM financial_profiles
    WHERE user_id = ?
  `).get(userId)

  return {
    monthlyIncome: row?.monthlyIncome ?? defaultProfile.monthlyIncome,
    currentMoney: row?.currentMoney ?? defaultProfile.currentMoney,
    fixedExpenses: row?.fixedExpenses ?? defaultProfile.fixedExpenses,
    plannedSpending: row?.plannedSpending ?? defaultProfile.plannedSpending,
    savingsAllocation: row?.savingsAllocation ?? defaultProfile.savingsAllocation,
    trackingMode: row?.trackingMode ?? defaultProfile.trackingMode,
    focusAreas: row?.focusAreas ? JSON.parse(row.focusAreas) : JSON.parse(defaultProfile.focusAreas),
  }
}

const getDashboardData = (userId) => {
  const profile = getProfile(userId)
  const tasks = db.prepare(`
    SELECT id, title, category, due_label AS due, priority, completed
    FROM tasks
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId)

  const goals = db.prepare(`
    SELECT id, name, current_amount AS current, target_amount AS target, due_date AS date, contribution
    FROM goals
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId)

  const transactions = db.prepare(`
    SELECT id, description, amount, category, type, source, created_at
    FROM transactions
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId)

  const bills = db.prepare(`
    SELECT id, name, amount, frequency, due_date AS dueDate, category, is_fixed AS isFixed, is_estimated AS isEstimated, active
    FROM bills
    WHERE user_id = ? AND active = 1
    ORDER BY due_date ASC
  `).all(userId)

  const incomes = db.prepare(`
    SELECT id, source, amount, frequency, next_date AS nextDate, is_variable AS isVariable, notes
    FROM incomes
    WHERE user_id = ?
    ORDER BY next_date ASC
  `).all(userId)

  const subscriptions = db.prepare(`
    SELECT id, merchant, amount, frequency, next_date AS nextDate, status
    FROM subscriptions
    WHERE user_id = ?
    ORDER BY next_date ASC
  `).all(userId)
  const accounts = db.prepare(`
    SELECT id, name, type, balance, CASE WHEN plaid_account_id IS NULL THEN 'Manual' ELSE 'Connected' END AS status,
           mask, plaid_item_id AS itemId,
           date(COALESCE(updated_at, created_at)) AS lastUpdated
    FROM accounts
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId)

  const safeToSpend = Math.max(profile.currentMoney - profile.fixedExpenses - profile.plannedSpending - profile.savingsAllocation, 0)
  const projectedBalance = profile.currentMoney + profile.monthlyIncome - profile.fixedExpenses - profile.plannedSpending - profile.savingsAllocation
  const weatherState = safeToSpend > 400 ? 'Grounded' : safeToSpend > 150 ? 'Drifting' : 'Unsteady'

  return {
    user: db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId),
    profile,
    safeToSpend,
    totalMoney: profile.currentMoney,
    projectedBalance,
    weatherState,
    tasks,
    goals,
    transactions,
    bills,
    incomes,
    subscriptions,
    accounts,
  }
}

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
      `).run(hasMore ? connection.cursor : cursor, connection.item_id, connection.user_id)
    })()
    return { addedCount, modifiedCount, complete: !hasMore }
  })().finally(() => activeBankSyncs.delete(connection.item_id))
  activeBankSyncs.set(connection.item_id, sync)
  return sync
}

const bankSyncTimer = setInterval(() => {
  if (!plaidClient) return
  const connections = db.prepare("SELECT * FROM bank_connections WHERE status = 'connected'").all()
  for (const connection of connections) {
    void syncPlaidConnection(connection).catch((error) => {
      console.error('Automatic bank transaction sync failed:', error?.response?.data?.error_code || error?.code || error?.message || 'Unknown Plaid error')
    })
  }
}, 15 * 60 * 1000)
bankSyncTimer.unref()

app.get('/privacy', (_req, res) => {
  res.type('html').send(renderLegalPage('privacy', publicLegalPages.privacy))
})

app.get('/terms', (_req, res) => {
  res.type('html').send(renderLegalPage('terms', publicLegalPages.terms))
})

app.get('/copyright', (_req, res) => {
  res.type('html').send(renderLegalPage('copyright', publicLegalPages.copyright))
})

app.get('/api/billing/status', withUser, (req, res) => {
  return res.json(getBillingStatus(req.user.id))
})

app.get('/api/banking/status', withUser, (req, res) => {
  const connections = db.prepare(`
    SELECT item_id AS itemId, institution_name AS institutionName, status,
           last_synced_at AS lastSyncedAt, created_at AS connectedAt
    FROM bank_connections
    WHERE user_id = ? AND status = 'connected'
    ORDER BY created_at DESC
  `).all(req.user.id)
  const transactions = db.prepare(`
    SELECT id, description, amount, category, type, source, created_at, account_id AS accountId
    FROM transactions
    WHERE user_id = ? AND source = 'bank'
    ORDER BY created_at DESC
    LIMIT 100
  `).all(req.user.id)
  return res.json({ enabled: Boolean(plaidClient), country: 'US', connections, transactions })
})

app.post('/api/banking/link-token', withUser, async (req, res, next) => {
  if (!plaidClient) return res.status(503).json({ error: 'Automatic bank connections are not configured yet.' })
  if (req.body?.consent !== true) {
    return res.status(400).json({ error: 'Explicit consent is required before starting bank connection.' })
  }
  if (!enforceRateLimit(req, 'bank-link', 5)) {
    return res.status(429).json({ error: 'Too many bank-link attempts. Please wait and try again.' })
  }
  try {
    const result = await plaidClient.linkTokenCreate({
      user: { client_user_id: String(req.user.id) },
      client_name: 'Grounded',
      products: [Products.Transactions],
      country_codes: ['US'],
      language: 'en',
      transactions: { days_requested: 90 },
      ...(process.env.PLAID_REDIRECT_URI ? { redirect_uri: process.env.PLAID_REDIRECT_URI } : {}),
    })
    return res.json({ linkToken: result.data.link_token, expiration: result.data.expiration })
  } catch (error) {
    logPlaidFailure('Plaid link-token creation failed:', error)
    return res.status(502).json({ error: 'The secure bank connection service is temporarily unavailable.' })
  }
})

app.post('/api/banking/exchange', withUser, async (req, res, next) => {
  if (!plaidClient) return res.status(503).json({ error: 'Automatic bank connections are not configured yet.' })
  if (!enforceRateLimit(req, 'bank-link', 5)) {
    return res.status(429).json({ error: 'Too many bank-link attempts. Please wait and try again.' })
  }
  const publicToken = req.body?.publicToken
  const institutionName = sanitizeText(req.body?.institutionName, 'Financial institution').slice(0, 100)
  if (typeof publicToken !== 'string' || publicToken.length < 10 || publicToken.length > 500) {
    return res.status(400).json({ error: 'A valid Plaid public token is required.' })
  }
  try {
    const exchanged = await plaidClient.itemPublicTokenExchange({ public_token: publicToken })
    const itemId = exchanged.data.item_id
    const existing = db.prepare('SELECT user_id FROM bank_connections WHERE item_id = ?').get(itemId)
    if (existing) {
      if (existing.user_id !== req.user.id) return res.status(409).json({ error: 'This bank connection is already linked to another account.' })
      return res.status(409).json({ error: 'This bank is already linked to your Grounded account.' })
    }
    const encryptedToken = encryptBankAccessToken(exchanged.data.access_token)
    db.prepare(`
      INSERT INTO bank_connections (
        item_id, user_id, institution_name, encrypted_access_token, encryption_iv, encryption_tag
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      itemId,
      req.user.id,
      institutionName,
      encryptedToken.encryptedAccessToken,
      encryptedToken.encryptionIv,
      encryptedToken.encryptionTag,
    )
    notifyUser(
      req.user,
      'bank_connected',
      'Bank connected',
      `${institutionName} was connected for transaction and balance syncing.`,
      `${institutionName} was connected to your Grounded account at ${new Date().toUTCString()}. If you did not authorize this, disconnect it in Money and contact support.`,
    )
    try {
      const connection = db.prepare('SELECT * FROM bank_connections WHERE item_id = ? AND user_id = ?').get(itemId, req.user.id)
      const result = await syncPlaidConnection(connection)
      return res.status(201).json({ connected: true, syncStatus: result.complete ? 'synced' : 'pending' })
    } catch (error) {
      logPlaidFailure('Initial bank transaction sync failed:', error)
      return res.status(202).json({
        connected: true,
        syncStatus: 'pending',
        message: 'Bank connected, but its first sync is still pending. Try syncing again shortly.',
      })
    }
  } catch (error) {
    if (error?.response) {
      logPlaidFailure('Plaid token exchange failed:', error)
      return res.status(502).json({ error: 'The secure bank connection could not be completed. Try again.' })
    }
    return next(error)
  }
})

app.post('/api/banking/sync', withUser, async (req, res, next) => {
  if (!plaidClient) return res.status(503).json({ error: 'Automatic bank connections are not configured yet.' })
  if (!enforceRateLimit(req, 'bank-sync', 5)) {
    return res.status(429).json({ error: 'Too many sync requests. Please wait and try again.' })
  }
  const connections = db.prepare("SELECT * FROM bank_connections WHERE user_id = ? AND status = 'connected'")
    .all(req.user.id)
  const results = []
  for (const connection of connections) {
    try {
      const result = await syncPlaidConnection(connection)
      results.push({ itemId: connection.item_id, institutionName: connection.institution_name, ...result })
    } catch (error) {
      logPlaidFailure('Manual bank transaction sync failed:', error)
      results.push({ itemId: connection.item_id, institutionName: connection.institution_name, error: 'This institution could not be synced. Try again later.' })
    }
  }
  const failed = results.some((result) => 'error' in result)
  return res.status(failed ? 207 : 200).json({ results })
})

app.delete('/api/banking/connections/:itemId', withUser, async (req, res, next) => {
  if (!plaidClient) return res.status(503).json({ error: 'Automatic bank connections are not configured.' })
  const connection = db.prepare(`
    SELECT * FROM bank_connections
    WHERE item_id = ? AND user_id = ? AND status = 'connected'
  `).get(req.params.itemId, req.user.id)
  if (!connection) return res.status(404).json({ error: 'Bank connection not found.' })
  try {
    await plaidClient.itemRemove({ access_token: decryptBankAccessToken(connection) })
    db.transaction(() => {
      db.prepare("DELETE FROM transactions WHERE user_id = ? AND source = 'bank' AND plaid_item_id = ?")
        .run(req.user.id, connection.item_id)
      db.prepare('DELETE FROM accounts WHERE user_id = ? AND plaid_item_id = ?').run(req.user.id, connection.item_id)
      db.prepare('DELETE FROM bank_connections WHERE item_id = ? AND user_id = ?').run(connection.item_id, req.user.id)
    })()
    notifyUser(req.user, 'bank_disconnected', 'Bank disconnected', `${connection.institution_name} was disconnected. Its imported accounts and transactions were removed.`)
    return res.json({ success: true })
  } catch (error) {
    logPlaidFailure('Plaid disconnect failed:', error)
    return res.status(502).json({ error: 'The bank connection could not be revoked. Try again or contact support.' })
  }
})

app.get('/api/notifications', withUser, (req, res) => {
  const notifications = db.prepare(`
    SELECT id, event, title, message, created_at AS createdAt, read_at AS readAt
    FROM user_notifications
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 100
  `).all(req.user.id)
  const unreadCount = db.prepare('SELECT COUNT(*) AS count FROM user_notifications WHERE user_id = ? AND read_at IS NULL')
    .get(req.user.id).count
  return res.json({ notifications, unreadCount, emailEnabled: Boolean(emailTransport) })
})

app.post('/api/notifications/:id/read', withUser, (req, res) => {
  const notificationId = Number(req.params.id)
  if (!Number.isSafeInteger(notificationId) || notificationId <= 0) {
    return res.status(400).json({ error: 'Notification ID is invalid.' })
  }
  const result = db.prepare(`
    UPDATE user_notifications SET read_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ? AND read_at IS NULL
  `).run(notificationId, req.user.id)
  if (!result.changes && !db.prepare('SELECT 1 FROM user_notifications WHERE id = ? AND user_id = ?').get(notificationId, req.user.id)) {
    return res.status(404).json({ error: 'Notification not found.' })
  }
  return res.json({ success: true })
})

app.post('/api/notifications/read-all', withUser, (req, res) => {
  db.prepare('UPDATE user_notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL')
    .run(req.user.id)
  return res.json({ success: true })
})

app.post('/api/accounts', withUser, (req, res) => {
  const name = sanitizeText(req.body?.name)
  const type = sanitizeText(req.body?.type)
  const balance = Number(req.body?.balance)
  const accountTypes = ['Checking', 'Savings', 'Credit card', 'Cash', 'Investment', 'Other']
  if (!name || name.length > 100 || !accountTypes.includes(type) || !Number.isFinite(balance) || Math.abs(balance) > 100000000) {
    return res.status(400).json({ error: 'Enter an account name, supported account type, and a balance within +/- 100,000,000.' })
  }
  const result = db.prepare('INSERT INTO accounts (user_id, name, type, balance) VALUES (?, ?, ?, ?)')
    .run(req.user.id, name, type, balance)
  const account = db.prepare(`
    SELECT id, name, type, balance, 'Manual' AS status, date(COALESCE(updated_at, created_at)) AS lastUpdated
    FROM accounts WHERE id = ? AND user_id = ?
  `).get(result.lastInsertRowid, req.user.id)
  notifyUser(
    req.user,
    'manual_account_added',
    'Manual account added',
    `${account.name} was added to your Grounded money overview as a manually tracked account. No bank login details were used or stored.`,
    `A manually tracked account was added to your Grounded money overview at ${new Date().toUTCString()}. Grounded does not connect to your bank or store bank login details.`,
  )
  return res.status(201).json(account)
})

app.post('/api/billing/checkout', withUser, async (req, res, next) => {
  if (!stripe || !stripePrices.monthly || !stripePrices.annual) {
    return res.status(503).json({ error: 'Paid plans are not configured yet. Please try again later.' })
  }
  if (!enforceRateLimit(req, 'billing-checkout', 5)) {
    return res.status(429).json({ error: 'Too many checkout requests. Please wait and try again.' })
  }
  if (getBillingStatus(req.user.id).plan === 'plus') {
    return res.status(409).json({ error: 'Your account already has Grounded Plus.' })
  }

  const interval = req.body?.interval
  const priceId = interval === 'monthly' ? stripePrices.monthly : interval === 'annual' ? stripePrices.annual : null
  if (!priceId) {
    return res.status(400).json({ error: 'Choose a valid monthly or annual plan.' })
  }

  try {
    const price = await stripe.prices.retrieve(priceId)
    const expectedAmount = interval === 'monthly' ? 599 : 5999
    const expectedInterval = interval === 'monthly' ? 'month' : 'year'
    if (
      !price.active
      || price.currency !== 'usd'
      || price.unit_amount !== expectedAmount
      || price.recurring?.interval !== expectedInterval
      || price.recurring?.interval_count !== 1
    ) {
      return res.status(503).json({ error: 'The configured Stripe price does not match the advertised plan. Contact support.' })
    }

    let billingRecord = db.prepare('SELECT stripe_customer_id, checkout_session_id, stripe_subscription_id, status FROM billing_subscriptions WHERE user_id = ?')
      .get(req.user.id)
    if (billingRecord?.checkout_session_id) {
      const priorCheckout = await stripe.checkout.sessions.retrieve(billingRecord.checkout_session_id)
      if (priorCheckout.status === 'open' && priorCheckout.url) {
        return res.json({ url: priorCheckout.url })
      }
      if (priorCheckout.status === 'complete') {
        return res.status(409).json({ error: 'Payment confirmation is still processing. Refresh your plan status shortly.' })
      }
      db.prepare('UPDATE billing_subscriptions SET checkout_session_id = NULL WHERE user_id = ?').run(req.user.id)
    }
    if (billingRecord?.stripe_subscription_id && !['canceled', 'incomplete_expired'].includes(billingRecord.status)) {
      return res.status(409).json({ error: 'A subscription already exists. Manage it in the billing portal.' })
    }
    if (!billingRecord?.stripe_customer_id) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        name: req.user.name,
        metadata: { userId: String(req.user.id) },
      })
      db.prepare(`
        INSERT INTO billing_subscriptions (user_id, stripe_customer_id)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id, updated_at = CURRENT_TIMESTAMP
      `).run(req.user.id, customer.id)
      billingRecord = { stripe_customer_id: customer.id }
    }

    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: billingRecord.stripe_customer_id,
      client_reference_id: String(req.user.id),
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { userId: String(req.user.id) },
      subscription_data: { metadata: { userId: String(req.user.id) } },
      success_url: new URL('/?billing=success', appBaseUrl).toString(),
      cancel_url: new URL('/?billing=cancelled', appBaseUrl).toString(),
    })
    db.prepare('UPDATE billing_subscriptions SET checkout_session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?')
      .run(checkout.id, req.user.id)
    return res.json({ url: checkout.url })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/billing/portal', withUser, async (req, res, next) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Subscription billing is not configured yet.' })
  }
  const billingRecord = db.prepare('SELECT stripe_customer_id FROM billing_subscriptions WHERE user_id = ?')
    .get(req.user.id)
  if (!billingRecord?.stripe_customer_id) {
    return res.status(404).json({ error: 'No billing account exists yet.' })
  }
  if (!enforceRateLimit(req, 'billing-portal', 10)) {
    return res.status(429).json({ error: 'Too many billing requests. Please wait and try again.' })
  }

  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: billingRecord.stripe_customer_id,
      return_url: new URL('/?tab=Plans', appBaseUrl).toString(),
    })
    return res.json({ url: portal.url })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/premium/insights', withUser, requirePlus, (req, res) => {
  const categories = db.prepare(`
    SELECT category, SUM(amount) AS total, COUNT(*) AS transactionCount
    FROM transactions
    WHERE user_id = ? AND type = 'Expense'
      AND created_at >= date('now', 'start of month')
    GROUP BY category
    ORDER BY total DESC
    LIMIT 5
  `).all(req.user.id)
  const totals = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS transactionCount
    FROM transactions
    WHERE user_id = ? AND type = 'Expense'
      AND created_at >= date('now', 'start of month')
  `).get(req.user.id)
  return res.json({ period: 'current month', totalSpent: totals.total, transactionCount: totals.transactionCount, categories })
})

app.get('/api/me', withUser, (req, res) => {
  return res.json({ user: req.user })
})

app.get('/api/dashboard', withUser, (req, res) => {
  const dashboard = getDashboardData(req.user.id)
  return res.json(dashboard)
})

app.get('/api/data/export', withUser, (req, res) => {
  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.user.id)
  const payload = {
    user,
    profile: getProfile(req.user.id),
    tasks: db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id),
    goals: db.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id),
    transactions: db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id),
    bills: db.prepare('SELECT * FROM bills WHERE user_id = ? ORDER BY due_date ASC').all(req.user.id),
    incomes: db.prepare('SELECT * FROM incomes WHERE user_id = ? ORDER BY next_date ASC').all(req.user.id),
    subscriptions: db.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY next_date ASC').all(req.user.id),
    accounts: db.prepare('SELECT id, name, type, balance, mask, created_at, updated_at FROM accounts WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id),
    bankConnections: db.prepare('SELECT institution_name AS institutionName, status, last_synced_at AS lastSyncedAt FROM bank_connections WHERE user_id = ? AND status = ?').all(req.user.id, 'connected'),
    notifications: db.prepare('SELECT id, event, title, message, created_at, read_at FROM user_notifications WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id),
    billing: getBillingStatus(req.user.id),
    exportedAt: new Date().toISOString(),
  }

  return res.json(payload)
})

app.delete('/api/data/delete', withUser, async (req, res, next) => {
  const billingRecord = db.prepare('SELECT checkout_session_id, stripe_subscription_id, status FROM billing_subscriptions WHERE user_id = ?')
    .get(req.user.id)
  if (billingRecord?.stripe_subscription_id || billingRecord?.checkout_session_id) {
    if (!stripe) {
      return res.status(503).json({ error: 'Billing could not be cancelled. Contact support before deleting your account.' })
    }
    try {
      const subscriptionsToCancel = new Set()
      const cancelSubscriptionIfBillable = async (subscriptionId) => {
        if (!subscriptionId || subscriptionsToCancel.has(subscriptionId)) return
        subscriptionsToCancel.add(subscriptionId)
        const subscription = await stripe.subscriptions.retrieve(subscriptionId)
        if (!['canceled', 'incomplete_expired'].includes(subscription.status)) {
          await stripe.subscriptions.cancel(subscriptionId)
        }
      }
      await cancelSubscriptionIfBillable(billingRecord.stripe_subscription_id)
      if (billingRecord.checkout_session_id) {
        const checkout = await stripe.checkout.sessions.retrieve(billingRecord.checkout_session_id)
        if (checkout.status === 'open') {
          await stripe.checkout.sessions.expire(checkout.id)
        } else if (checkout.status === 'complete' && checkout.subscription) {
          const subscriptionId = typeof checkout.subscription === 'string' ? checkout.subscription : checkout.subscription.id
          await cancelSubscriptionIfBillable(subscriptionId)
        }
      }
    } catch (error) {
      return next(error)
    }
  }

  if (plaidClient) {
    const connections = db.prepare("SELECT * FROM bank_connections WHERE user_id = ? AND status = 'connected'")
      .all(req.user.id)
    for (const connection of connections) {
      try {
        await plaidClient.itemRemove({ access_token: decryptBankAccessToken(connection) })
        db.prepare("UPDATE bank_connections SET status = 'removed', encrypted_access_token = '', encryption_iv = '', encryption_tag = '' WHERE item_id = ? AND user_id = ?")
          .run(connection.item_id, req.user.id)
      } catch (error) {
        console.error('Bank unlink during account deletion failed:', error?.response?.data?.error_code || error?.code || error?.message || 'Unknown Plaid error')
        return res.status(502).json({ error: 'A bank connection could not be revoked, so the account was not deleted. Try again or contact support.' })
      }
    }
  } else if (db.prepare("SELECT 1 FROM bank_connections WHERE user_id = ? AND status = 'connected'").get(req.user.id)) {
    return res.status(503).json({ error: 'Bank connections could not be revoked, so the account was not deleted. Restore Plaid configuration or contact support.' })
  }

  const deletionNotification = {
    ...req.user,
    email: req.user.email,
  }
  notifyUser(
    deletionNotification,
    'account_deleted',
    'Account deletion requested',
    'Your Grounded account and stored data are being permanently deleted.',
    `Grounded received a request to permanently delete your account at ${new Date().toUTCString()}. If you did not request this, contact support.`,
  )

  const tables = [
    'tasks',
    'goals',
    'transactions',
    'bills',
    'incomes',
    'subscriptions',
    'accounts',
    'bank_connections',
    'financial_profiles',
  ]

  db.transaction(() => {
    for (const table of tables) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(req.user.id)
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id)
  })()
  return res.json({ success: true })
})

app.post('/api/profile', withUser, (req, res) => {
  const { name, monthlyIncome, currentMoney, fixedExpenses, plannedSpending, savingsAllocation, trackingMode, focusAreas } = req.body || {}
  const safeName = name === undefined ? req.user.name : sanitizeText(name)
  if (!safeName || safeName.length > 80) {
    return res.status(400).json({ error: 'Name must contain 1 to 80 characters.' })
  }
  const parsedValues = [monthlyIncome, currentMoney, fixedExpenses, plannedSpending, savingsAllocation].map(parseCurrency)
  if (parsedValues.some((value) => value === null)) {
    return res.status(400).json({ error: 'Financial values must be valid non-negative numbers no greater than 100,000,000.' })
  }
  if (trackingMode !== undefined && !['Manual', 'Automatic', 'Hybrid'].includes(String(trackingMode))) {
    return res.status(400).json({ error: 'Tracking mode must be Manual, Automatic, or Hybrid.' })
  }
  if (focusAreas !== undefined && (!Array.isArray(focusAreas) || focusAreas.length > 8 || focusAreas.some((item) => typeof item !== 'string' || item.length > 100))) {
    return res.status(400).json({ error: 'Focus areas must be an array of at most 8 short text values.' })
  }
  const values = {
    monthlyIncome: parsedValues[0],
    currentMoney: parsedValues[1],
    fixedExpenses: parsedValues[2],
    plannedSpending: parsedValues[3],
    savingsAllocation: parsedValues[4],
    trackingMode: String(trackingMode || 'Manual'),
    focusAreas: JSON.stringify((focusAreas || []).slice(0, 8).map((item) => String(item).trim()).filter(Boolean)),
  }

  db.transaction(() => {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(safeName, req.user.id)
    db.prepare(`
    INSERT INTO financial_profiles (user_id, monthly_income, current_money, fixed_expenses, planned_spending, savings_allocation, tracking_mode, focus_areas)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      monthly_income = excluded.monthly_income,
      current_money = excluded.current_money,
      fixed_expenses = excluded.fixed_expenses,
      planned_spending = excluded.planned_spending,
      savings_allocation = excluded.savings_allocation,
      tracking_mode = excluded.tracking_mode,
      focus_areas = excluded.focus_areas,
      updated_at = CURRENT_TIMESTAMP
    `).run(
      req.user.id,
      values.monthlyIncome,
      values.currentMoney,
      values.fixedExpenses,
      values.plannedSpending,
      values.savingsAllocation,
      values.trackingMode,
      values.focusAreas,
    )
  })()

  return res.json(getDashboardData(req.user.id))
})

app.get('/api/tasks', withUser, (req, res) => {
  const tasks = db.prepare(`SELECT id, title, category, due_label AS due, priority, completed FROM tasks WHERE user_id = ? ORDER BY created_at DESC`).all(req.user.id)
  return res.json(tasks)
})

app.post('/api/tasks', withUser, (req, res) => {
  const { title, category, due, priority } = req.body || {}
  const safeTitle = sanitizeText(title)
  const safeCategory = sanitizeText(category)
  const safeDue = sanitizeText(due)
  const safePriority = ['High', 'Medium', 'Low'].includes(String(priority || '')) ? String(priority) : 'Medium'

  if (!safeTitle || !safeCategory || !safeDue || !safePriority) {
    return res.status(400).json({ error: 'Task details are required.' })
  }

  const result = db.prepare('INSERT INTO tasks (user_id, title, category, due_label, priority, completed) VALUES (?, ?, ?, ?, ?, 0)').run(req.user.id, safeTitle, safeCategory, safeDue, safePriority)
  const task = db.prepare('SELECT id, title, category, due_label AS due, priority, completed FROM tasks WHERE id = ?').get(result.lastInsertRowid)
  return res.status(201).json(task)
})

app.patch('/api/tasks/:id/toggle', withUser, (req, res) => {
  const task = db.prepare('SELECT id, completed FROM tasks WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id)
  if (!task) {
    return res.status(404).json({ error: 'Task not found.' })
  }
  db.prepare('UPDATE tasks SET completed = ? WHERE id = ?').run(task.completed ? 0 : 1, task.id)
  return res.json({ success: true })
})

app.get('/api/goals', withUser, (req, res) => {
  const goals = db.prepare(`SELECT id, name, current_amount AS current, target_amount AS target, due_date AS date, contribution FROM goals WHERE user_id = ? ORDER BY created_at DESC`).all(req.user.id)
  return res.json(goals)
})

app.post('/api/goals', withUser, (req, res) => {
  const { name, target, date, contribution } = req.body || {}
  const safeName = sanitizeText(name)
  const safeTarget = parseCurrency(target)

  if (!safeName || safeName.length > 120 || safeTarget === null || safeTarget <= 0) {
    return res.status(400).json({ error: 'Goal name and target are required.' })
  }
  if (getBillingStatus(req.user.id).plan !== 'plus') {
    const currentGoalCount = db.prepare('SELECT COUNT(*) AS count FROM goals WHERE user_id = ?').get(req.user.id).count
    if (currentGoalCount >= 3) {
      return res.status(402).json({ error: 'Free accounts can have up to 3 goals. Upgrade to Grounded Plus for unlimited goals.', code: 'PLUS_REQUIRED' })
    }
  }

  const result = db.prepare('INSERT INTO goals (user_id, name, current_amount, target_amount, due_date, contribution) VALUES (?, ?, 0, ?, ?, ?)')
    .run(req.user.id, safeName, safeTarget, sanitizeText(date), sanitizeText(contribution))
  const goal = db.prepare('SELECT id, name, current_amount AS current, target_amount AS target, due_date AS date, contribution FROM goals WHERE id = ?').get(result.lastInsertRowid)
  return res.status(201).json(goal)
})

app.get('/api/transactions', withUser, (req, res) => {
  const transactions = db.prepare(`SELECT id, description, amount, category, type, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC`).all(req.user.id)
  return res.json(transactions)
})

app.post('/api/transactions', withUser, (req, res) => {
  const { description, amount, category, type } = req.body || {}
  const safeDescription = sanitizeText(description)
  const safeCategory = sanitizeText(category)
  const safeType = ['Income', 'Expense'].includes(String(type || '')) ? String(type) : 'Expense'
  const safeAmount = parseCurrency(amount)

  if (!safeDescription || safeDescription.length > 160 || !safeCategory || safeCategory.length > 80 || safeAmount === null || safeAmount <= 0 || !['Income', 'Expense'].includes(String(type || ''))) {
    return res.status(400).json({ error: 'Transaction details are required.' })
  }

  const transaction = db.transaction(() => {
    const result = db.prepare('INSERT INTO transactions (user_id, description, amount, category, type) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, safeDescription, safeAmount, safeCategory, safeType)
    if (safeType === 'Income') {
      db.prepare('UPDATE financial_profiles SET current_money = current_money + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(safeAmount, req.user.id)
    } else {
      db.prepare('UPDATE financial_profiles SET current_money = current_money - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(safeAmount, req.user.id)
    }
    return db.prepare('SELECT id, description, amount, category, type, created_at FROM transactions WHERE id = ?').get(result.lastInsertRowid)
  })()

  return res.status(201).json(transaction)
})

app.get('/api/bills', withUser, (req, res) => {
  const bills = db.prepare(`SELECT id, name, amount, frequency, due_date AS dueDate, category, is_fixed AS isFixed, is_estimated AS isEstimated, active FROM bills WHERE user_id = ? ORDER BY due_date ASC`).all(req.user.id)
  return res.json(bills)
})

app.post('/api/bills', withUser, (req, res) => {
  const { name, amount, frequency, dueDate, category, isFixed, isEstimated, active } = req.body || {}
  const safeName = sanitizeText(name)
  const safeDueDate = sanitizeText(dueDate)
  const safeCategory = sanitizeText(category)
  const safeAmount = parseCurrency(amount)

  if (!safeName || safeName.length > 120 || safeAmount === null || safeAmount <= 0 || !safeDueDate || safeDueDate.length > 80 || !safeCategory || safeCategory.length > 80) {
    return res.status(400).json({ error: 'Bill name, amount, due date, and category are required.' })
  }

  const result = db.prepare('INSERT INTO bills (user_id, name, amount, frequency, due_date, category, is_fixed, is_estimated, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, safeName, safeAmount, sanitizeText(frequency, 'Monthly'), safeDueDate, safeCategory, Number(Boolean(isFixed)), Number(Boolean(isEstimated)), Number(active !== false))

  const bill = db.prepare('SELECT id, name, amount, frequency, due_date AS dueDate, category, is_fixed AS isFixed, is_estimated AS isEstimated, active FROM bills WHERE id = ?').get(result.lastInsertRowid)
  return res.status(201).json(bill)
})

app.get('/api/income', withUser, (req, res) => {
  const incomes = db.prepare(`SELECT id, source, amount, frequency, next_date AS nextDate, is_variable AS isVariable, notes FROM incomes WHERE user_id = ? ORDER BY next_date ASC`).all(req.user.id)
  return res.json(incomes)
})

app.post('/api/income', withUser, (req, res) => {
  const { source, amount, frequency, nextDate, isVariable, notes } = req.body || {}
  const safeSource = sanitizeText(source)
  const safeNextDate = sanitizeText(nextDate)
  const safeAmount = parseCurrency(amount)

  if (!safeSource || safeSource.length > 120 || safeAmount === null || safeAmount <= 0 || !safeNextDate || safeNextDate.length > 80) {
    return res.status(400).json({ error: 'Income source, amount, and next date are required.' })
  }

  const result = db.prepare('INSERT INTO incomes (user_id, source, amount, frequency, next_date, is_variable, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, safeSource, safeAmount, sanitizeText(frequency, 'Monthly'), safeNextDate, Number(Boolean(isVariable)), sanitizeText(notes, ''))

  const income = db.prepare('SELECT id, source, amount, frequency, next_date AS nextDate, is_variable AS isVariable, notes FROM incomes WHERE id = ?').get(result.lastInsertRowid)
  return res.status(201).json(income)
})

app.get('/api/subscriptions', withUser, (req, res) => {
  const subscriptions = db.prepare(`SELECT id, merchant, amount, frequency, next_date AS nextDate, status FROM subscriptions WHERE user_id = ? ORDER BY next_date ASC`).all(req.user.id)
  return res.json(subscriptions)
})

app.post('/api/subscriptions', withUser, (req, res) => {
  const { merchant, amount, frequency, nextDate, status } = req.body || {}
  const safeMerchant = sanitizeText(merchant)
  const safeNextDate = sanitizeText(nextDate)
  const safeAmount = parseCurrency(amount)

  if (!safeMerchant || safeMerchant.length > 120 || safeAmount === null || safeAmount <= 0 || !safeNextDate || safeNextDate.length > 80) {
    return res.status(400).json({ error: 'Subscription merchant, amount, and next renewal date are required.' })
  }

  const result = db.prepare('INSERT INTO subscriptions (user_id, merchant, amount, frequency, next_date, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, safeMerchant, safeAmount, sanitizeText(frequency, 'Monthly'), safeNextDate, sanitizeText(status, 'Active'))

  const subscription = db.prepare('SELECT id, merchant, amount, frequency, next_date AS nextDate, status FROM subscriptions WHERE id = ?').get(result.lastInsertRowid)
  return res.status(201).json(subscription)
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'grounded-api', uptimeMs: Date.now() - appStartTime, timestamp: new Date().toISOString() })
})

app.get('/api/health', (_req, res) => {
  const dbStatus = db.prepare('SELECT 1').get() ? 'healthy' : 'unhealthy'
  res.json({ ok: dbStatus === 'healthy', service: 'grounded-api', uptimeMs: Date.now() - appStartTime, db: dbStatus, timestamp: new Date().toISOString() })
})

app.use((error, _req, res, _next) => {
  if (error?.message === 'Origin not allowed by CORS policy.') {
    return res.status(403).json({ error: 'Origin not allowed by CORS policy.' })
  }
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' })
  }
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'Request body must be valid JSON.' })
  }
  console.error('Unhandled server error:', error)
  return res.status(500).json({ error: 'Internal server error.' })
})

app.listen(port, () => {
  console.log(`Grounded API listening on http://localhost:${port}`)
})
