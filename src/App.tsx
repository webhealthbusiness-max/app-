import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

type Tab = 'Home' | 'Money' | 'Forecast' | 'Goals' | 'Tasks' | 'Insights' | 'Plans' | 'Notifications' | 'Profile' | 'Privacy'
type TrackingMode = 'Manual' | 'Automatic' | 'Hybrid'
type TaskPriority = 'High' | 'Medium' | 'Low'
type TransactionType = 'Expense' | 'Income' | 'Transfer'
type AuthMode = 'login' | 'signup' | 'forgot' | 'reset'

type Account = {
  id?: number
  name: string
  type: string
  balance: number
  status: 'Connected' | 'Manual'
  lastUpdated: string
  mask?: string | null
  itemId?: string | null
}

type BankConnection = {
  itemId: string
  institutionName: string
  status: string
  lastSyncedAt: string | null
  connectedAt: string
}

type BankTransaction = {
  id: number
  description: string
  amount: number
  category: string
  type: TransactionType
  source: 'manual' | 'bank'
  created_at: string
}

type BankingStatus = {
  enabled: boolean
  country: string
  connections: BankConnection[]
  transactions: BankTransaction[]
}

type AppNotification = {
  id: number
  event: string
  title: string
  message: string
  createdAt: string
  readAt: string | null
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: { client_id: string; callback: (response: { credential: string }) => void }) => void
          renderButton: (parent: HTMLElement, options: { theme: string; size: string; shape: string; width: number }) => void
        }
      }
    }
    Plaid?: {
      create: (options: {
        token: string
        receivedRedirectUri?: string
        onSuccess: (publicToken: string, metadata: { institution?: { name?: string } }) => void
        onExit: (error: { error_message?: string } | null) => void
      }) => { open: () => void }
    }
  }
  }

type Goal = {
  id?: number
  name: string
  current: number
  target: number
  date: string
  contribution: string
}

type Bill = {
  id?: number
  name: string
  amount: number
  frequency: string
  dueDate: string
  category: string
  isFixed: boolean
  isEstimated: boolean
  active: boolean
}

type IncomeEntry = {
  id?: number
  source: string
  amount: number
  frequency: string
  nextDate: string
  isVariable: boolean
  notes: string
}

type Subscription = {
  id?: number
  merchant: string
  amount: number
  frequency: string
  nextDate: string
  status: string
}

type Task = {
  id?: number
  title: string
  category: string
  due: string
  priority: TaskPriority
  completed: boolean
}

type OnboardingForm = {
  name: string
  trackingMode: TrackingMode
  focusAreas: string[]
  monthlyIncome: number
  currentMoney: number
  fixedExpenses: number
  plannedSpending: number
  savingsAllocation: number
}

type DashboardData = {
  user: { id: number; name: string; email: string }
  profile: OnboardingForm
  safeToSpend: number
  totalMoney: number
  projectedBalance: number
  weatherState: string
  tasks: Task[]
  goals: Goal[]
  accounts: Account[]
  transactions: BankTransaction[]
  bills: Bill[]
  incomes: IncomeEntry[]
  subscriptions: Subscription[]
}

type BillingStatus = {
  plan: 'free' | 'plus'
  status: string
  currentPeriodEnd: string | null
  prices: { monthly: number; annual: number }
}

type PremiumInsights = {
  period: string
  totalSpent: number
  transactionCount: number
  categories: Array<{ category: string; total: number; transactionCount: number }>
}

const onboardingGoals = [
  'Keeping track of money',
  'Paying bills on time',
  'Controlling spending',
  'Saving money',
  'Organizing my life',
  'Understanding where my money goes',
  'Planning for the future',
  'All of the above',
]

const navItems: Tab[] = ['Home', 'Money', 'Forecast', 'Goals', 'Tasks', 'Insights', 'Plans', 'Notifications', 'Profile', 'Privacy']

const defaultForm: OnboardingForm = {
  name: '',
  trackingMode: 'Manual',
  focusAreas: [],
  monthlyIncome: 0,
  currentMoney: 0,
  fixedExpenses: 0,
  plannedSpending: 0,
  savingsAllocation: 0,
}

const getStoredToken = () => localStorage.getItem('grounded-token')

async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error((data as { error?: string }).error || 'Request failed')
  }

  return data as T
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value)
}

let plaidLinkScriptPromise: Promise<void> | null = null
const loadPlaidLinkSdk = () => {
  if (window.Plaid) return Promise.resolve()
  if (plaidLinkScriptPromise) return plaidLinkScriptPromise
  plaidLinkScriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
    script.async = true
    script.onload = () => window.Plaid ? resolve() : reject(new Error('Plaid Link did not initialize.'))
    script.onerror = () => reject(new Error('Could not load secure bank connection.'))
    document.head.appendChild(script)
  }).catch((error: unknown) => {
    plaidLinkScriptPromise = null
    throw error
  })
  return plaidLinkScriptPromise
}

function App() {
  const googleButtonRef = useRef<HTMLDivElement>(null)
  const splashStartedAt = useRef(performance.now())
  const [authMode, setAuthMode] = useState<AuthMode>('signup')
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '' })
  const [authError, setAuthError] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [authTokenFromLink, setAuthTokenFromLink] = useState('')
  const [isAuthenticated, setIsAuthenticated] = useState(Boolean(getStoredToken()))
  const [appReady, setAppReady] = useState(() => !Boolean(getStoredToken()))
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [billing, setBilling] = useState<BillingStatus>({
    plan: 'free',
    status: 'free',
    currentPeriodEnd: null,
    prices: { monthly: 5.99, annual: 59.99 },
  })
  const [billingMessage, setBillingMessage] = useState('')
  const [billingError, setBillingError] = useState('')
  const [billingBusy, setBillingBusy] = useState(false)
  const [premiumInsights, setPremiumInsights] = useState<PremiumInsights | null>(null)
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0)
  const [notificationsEmailEnabled, setNotificationsEmailEnabled] = useState(false)
  const [notificationsError, setNotificationsError] = useState('')
  const [accountError, setAccountError] = useState('')
  const [bankingStatus, setBankingStatus] = useState<BankingStatus>({
    enabled: false,
    country: 'US',
    connections: [],
    transactions: [],
  })
  const [bankingError, setBankingError] = useState('')
  const [bankingMessage, setBankingMessage] = useState('')
  const [bankingBusy, setBankingBusy] = useState(false)
  const [bankConsent, setBankConsent] = useState(false)
  const [loadingDashboard, setLoadingDashboard] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('Home')
  const [selectedPeriod, setSelectedPeriod] = useState('This Month')
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [showTransactionForm, setShowTransactionForm] = useState(false)
  const [showTaskForm, setShowTaskForm] = useState(false)
  const [showGoalForm, setShowGoalForm] = useState(false)
  const [purchaseAmount, setPurchaseAmount] = useState(0)
  const [onboardingStep, setOnboardingStep] = useState(0)
  const [form, setForm] = useState<OnboardingForm>(defaultForm)
  const [aiPrompt, setAiPrompt] = useState('')

  const [transactionDraft, setTransactionDraft] = useState({
    description: '',
    amount: 0,
    category: '',
    type: 'Expense' as TransactionType,
  })

  const [taskDraft, setTaskDraft] = useState({
    title: '',
    category: 'Money',
    due: 'Tomorrow',
    priority: 'Medium' as TaskPriority,
  })

  const [goalDraft, setGoalDraft] = useState({
    name: '',
    target: 0,
    date: '',
    contribution: '',
  })

  const [billDraft, setBillDraft] = useState({
    name: '',
    amount: 0,
    frequency: 'Monthly',
    dueDate: '',
    category: '',
    isFixed: true,
    isEstimated: false,
    active: true,
  })

  const [incomeDraft, setIncomeDraft] = useState({
    source: '',
    amount: 0,
    frequency: 'Monthly',
    nextDate: '',
    isVariable: false,
    notes: '',
  })

  const [subscriptionDraft, setSubscriptionDraft] = useState({
    merchant: '',
    amount: 0,
    frequency: 'Monthly',
    nextDate: '',
    status: 'Active',
  })
  const [accountDraft, setAccountDraft] = useState({ name: '', type: 'Checking', balance: 0 })

  const [showBillForm, setShowBillForm] = useState(false)
  const [showIncomeForm, setShowIncomeForm] = useState(false)
  const [showSubscriptionForm, setShowSubscriptionForm] = useState(false)
  const [showAccountForm, setShowAccountForm] = useState(false)
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
  const exchangeBankTokenRef = useRef<(publicToken: string, institutionName: string) => Promise<void>>(async () => {})

  useLayoutEffect(() => {
    if (!appReady) return
    const splash = document.getElementById('app-splash')
    if (!splash) return

    const minimumDuration = 900
    const remainingDuration = Math.max(0, minimumDuration - (performance.now() - splashStartedAt.current))
    const removeTimeout = window.setTimeout(() => splash.remove(), remainingDuration)
    return () => window.clearTimeout(removeTimeout)
  }, [appReady])

  useEffect(() => {
    if (!isAuthenticated) {
      setDashboard(null)
      setAppReady(true)
      return
    }

    const loadDashboard = async () => {
      const token = getStoredToken()
      if (!token) {
        setAppReady(true)
        return
      }
      try {
        setLoadingDashboard(true)
        const response = await fetchJson<DashboardData>('/api/dashboard', {
          headers: { Authorization: `Bearer ${token}` },
        })
        setDashboard(response)
        const billingResponse = await fetchJson<BillingStatus>('/api/billing/status', {
          headers: { Authorization: `Bearer ${token}` },
        })
        setBilling(billingResponse)
        setForm({
          ...defaultForm,
          ...response.profile,
          name: response.user.name,
          focusAreas: response.profile.focusAreas || defaultForm.focusAreas,
        })
      } catch (error) {
        console.error(error)
        setAuthError('Your session expired. Please log in again.')
        localStorage.removeItem('grounded-token')
        setIsAuthenticated(false)
      } finally {
        setLoadingDashboard(false)
        setAppReady(true)
      }
    }

    void loadDashboard()
  }, [isAuthenticated])

  const handleGoogleCredential = async (credential: string) => {
    setAuthBusy(true)
    setAuthError('')
    try {
      const payload = await fetchJson<{ token: string; user: { name: string; email: string }; newUser: boolean }>('/api/auth/google', {
        method: 'POST',
        body: JSON.stringify({ credential }),
      })
      localStorage.setItem('grounded-token', payload.token)
      setForm((prev) => ({ ...prev, name: payload.user.name }))
      setIsAuthenticated(true)
      setOnboardingStep(0)
      setShowOnboarding(payload.newUser)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Google sign-in failed.')
    } finally {
      setAuthBusy(false)
    }
  }

  useEffect(() => {
    if (isAuthenticated || !googleClientId || !googleButtonRef.current) return
    let cancelled = false
    let waitTimer: number | undefined
    let timeout: number | undefined
    let script: HTMLScriptElement | null = null
    let didInitialize = false

    const initializeGoogleSignIn = () => {
      if (didInitialize) return true
      if (cancelled || !window.google?.accounts.id || !googleButtonRef.current) return false
      didInitialize = true
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: (response) => { void handleGoogleCredential(response.credential) },
      })
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: 'outline',
        size: 'large',
        shape: 'rectangular',
        width: Math.min(420, Math.max(200, googleButtonRef.current.clientWidth || 420)),
      })
      return true
    }

    if (!initializeGoogleSignIn()) {
      script = document.createElement('script')
      script.src = 'https://accounts.google.com/gsi/client'
      script.async = true
      script.defer = true
      script.onload = () => {
        if (!initializeGoogleSignIn()) setAuthError('Google sign-in could not be initialized.')
      }
      script.onerror = () => setAuthError('Google sign-in could not be loaded.')
      document.head.appendChild(script)
      waitTimer = window.setInterval(() => {
        if (initializeGoogleSignIn() && waitTimer) window.clearInterval(waitTimer)
      }, 150)
      timeout = window.setTimeout(() => {
        if (waitTimer) window.clearInterval(waitTimer)
      }, 10000)
    }

    return () => {
      cancelled = true
      if (waitTimer) window.clearInterval(waitTimer)
      if (timeout) window.clearTimeout(timeout)
    }
  }, [isAuthenticated, googleClientId])

  useEffect(() => {
    const query = new URLSearchParams(window.location.search)
    const billingResult = query.get('billing')
    if (query.get('tab') === 'Plans' || billingResult) setActiveTab('Plans')
    if (billingResult === 'success') {
      setBillingMessage('Checkout complete. Your plan updates after Stripe confirms the subscription; refresh billing status in a moment if needed.')
    } else if (billingResult === 'cancelled') {
      setBillingMessage('Checkout was cancelled. You can choose a plan whenever you are ready.')
    }
    if (billingResult) {
      const url = new URL(window.location.href)
      url.searchParams.delete('billing')
      window.history.replaceState({}, '', url)
    }
  }, [])

  const safeToSpend = dashboard?.safeToSpend ?? Math.max(
    form.currentMoney - form.fixedExpenses - form.plannedSpending - form.savingsAllocation,
    0,
  )

  const totalMoney = dashboard?.totalMoney ?? form.currentMoney
  const projectedBalance = dashboard?.projectedBalance ?? form.currentMoney + form.monthlyIncome - form.fixedExpenses - form.plannedSpending - form.savingsAllocation
  const weatherState = dashboard?.weatherState ?? (safeToSpend > 400 ? 'Grounded' : safeToSpend > 150 ? 'Drifting' : 'Unsteady')
  const postPurchaseBalance = safeToSpend - purchaseAmount

  const assistantReply = useMemo(() => {
    const prompt = aiPrompt.toLowerCase()
    const purchaseText = formatCurrency(purchaseAmount)

    if (prompt.includes('afford') || prompt.includes('purchase') || prompt.includes('shoes')) {
      return `${purchaseText} is ${purchaseAmount > safeToSpend ? 'above' : 'within'} your current safe-to-spend. Based on your current information, your safe-to-spend sits at ${formatCurrency(safeToSpend)} and your projected end-of-month balance is ${formatCurrency(projectedBalance)}. This is a planning estimate, not a guarantee.`
    }

    if (prompt.includes('save') || prompt.includes('savings')) {
      return `Your current plan reserves ${formatCurrency(form.savingsAllocation)} for savings. If you keep that rate, your forecast remains ${formatCurrency(projectedBalance)} with a cushion of ${formatCurrency(safeToSpend)} for the month.`
    }

    if (prompt.includes('money') || prompt.includes('where')) {
      return `Your entered fixed expenses are ${formatCurrency(form.fixedExpenses)} and your planned spending is ${formatCurrency(form.plannedSpending)}. Your current plan leaves ${formatCurrency(safeToSpend)} after obligations and savings targets.`
    }

    if (prompt.includes('bill') || prompt.includes('payment')) {
      return `Your planned fixed expenses total ${formatCurrency(form.fixedExpenses)}. You entered ${formatCurrency(form.monthlyIncome)} as monthly income and ${formatCurrency(form.savingsAllocation)} as savings allocation. Review these manually entered figures before making decisions.`
    }

    return `Using the figures you entered, the monthly plan estimates ${formatCurrency(projectedBalance)} after listed income and commitments. This estimate is not financial advice and may not reflect your complete finances.`
  }, [aiPrompt, form.fixedExpenses, form.monthlyIncome, form.plannedSpending, form.savingsAllocation, projectedBalance, purchaseAmount, safeToSpend])

  const chartSegments = useMemo(() => {
    const fixedValue = Math.min(form.fixedExpenses, totalMoney)
    const plannedValue = Math.min(form.plannedSpending, Math.max(totalMoney - fixedValue, 0))
    const savingsValue = Math.min(form.savingsAllocation, Math.max(totalMoney - fixedValue - plannedValue, 0))
    const availableValue = Math.max(totalMoney - fixedValue - plannedValue - savingsValue, 0)

    return [
      { label: 'Fixed expenses', value: fixedValue, color: '#78967F' },
      { label: 'Planned spending', value: plannedValue, color: '#A9C0A8' },
      { label: 'Savings', value: savingsValue, color: '#1D2822' },
      { label: 'Available', value: availableValue, color: '#F5F3EC' },
    ]
  }, [form, totalMoney])

  const handleInputChange = (field: keyof OnboardingForm, value: string | number | string[]) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const toggleFocusArea = (item: string) => {
    setForm((prev) => {
      const exists = prev.focusAreas.includes(item)
      return {
        ...prev,
        focusAreas: exists ? prev.focusAreas.filter((entry) => entry !== item) : [...prev.focusAreas, item],
      }
    })
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const verificationToken = params.get('verifyEmail')
    const resetToken = params.get('resetPassword')
    if (verificationToken) {
      setAuthBusy(true)
      void fetchJson('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: verificationToken }) })
        .then((result: { message: string }) => { setAuthMessage(result.message); setAuthMode('login') })
        .catch((error) => setAuthError(error instanceof Error ? error.message : 'Could not verify email.'))
        .finally(() => { setAuthBusy(false); window.history.replaceState({}, document.title, window.location.pathname) })
    } else if (resetToken) {
      setAuthTokenFromLink(resetToken)
      setAuthMode('reset')
      window.history.replaceState({}, document.title, window.location.pathname)
    }
  }, [])

  const handleAuthSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setAuthError('')
    setAuthMessage('')
    setAuthBusy(true)
    try {
      if (authMode === 'forgot') {
        const result = await fetchJson<{ message: string }>('/api/auth/password-reset/request', { method: 'POST', body: JSON.stringify({ email: authForm.email }) })
        setAuthMessage(result.message)
        return
      }
      if (authMode === 'reset') {
        const result = await fetchJson<{ message: string }>('/api/auth/password-reset/complete', { method: 'POST', body: JSON.stringify({ token: authTokenFromLink, password: authForm.password }) })
        setAuthMessage(result.message)
        setAuthMode('login')
        setAuthTokenFromLink('')
        setAuthForm((prev) => ({ ...prev, password: '' }))
        return
      }
      const payload = authMode === 'login'
        ? await fetchJson<{ token: string; user: { name: string; email: string } }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: authForm.email, password: authForm.password }) })
        : await fetchJson<{ token?: string; message?: string; user?: { name: string; email: string } }>('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: authForm.name, email: authForm.email, password: authForm.password }) })
      if (!payload.token || !payload.user) { setAuthMessage(payload.message || 'Check your email for next steps.'); return }
      localStorage.setItem('grounded-token', payload.token)
      setForm((prev) => ({ ...prev, name: payload.user!.name }))
      setIsAuthenticated(true)
      setOnboardingStep(0)
      setShowOnboarding(authMode === 'signup')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed')
    } finally {
      setAuthBusy(false)
    }
  }

  const logout = () => {
    localStorage.removeItem('grounded-token')
    setIsAuthenticated(false)
    setDashboard(null)
    setBilling({ plan: 'free', status: 'free', currentPeriodEnd: null, prices: { monthly: 5.99, annual: 59.99 } })
    setPremiumInsights(null)
    setAuthMode('login')
    setAuthError('')
  }

  const loadNotifications = async () => {
    const token = getStoredToken()
    if (!token) return
    try {
      const result = await fetchJson<{
        notifications: AppNotification[]
        unreadCount: number
        emailEnabled: boolean
      }>('/api/notifications', { headers: { Authorization: `Bearer ${token}` } })
      setNotifications(result.notifications)
      setUnreadNotificationCount(result.unreadCount)
      setNotificationsEmailEnabled(result.emailEnabled)
      setNotificationsError('')
    } catch (error) {
      setNotificationsError(error instanceof Error ? error.message : 'Could not load notifications.')
    }
  }

  useEffect(() => {
    if (!isAuthenticated) {
      setNotifications([])
      setUnreadNotificationCount(0)
      return
    }
    void loadNotifications()
    const timer = window.setInterval(() => { void loadNotifications() }, 30000)
    return () => window.clearInterval(timer)
  }, [isAuthenticated])

  const markNotificationRead = async (notificationId: number) => {
    const token = getStoredToken()
    if (!token) return
    try {
      await fetchJson(`/api/notifications/${notificationId}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      await loadNotifications()
    } catch (error) {
      setNotificationsError(error instanceof Error ? error.message : 'Could not update this notification.')
    }
  }

  const markAllNotificationsRead = async () => {
    const token = getStoredToken()
    if (!token) return
    try {
      await fetchJson('/api/notifications/read-all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      await loadNotifications()
    } catch (error) {
      setNotificationsError(error instanceof Error ? error.message : 'Could not update notifications.')
    }
  }

  const loadBankingStatus = async () => {
    const token = getStoredToken()
    if (!token) return
    try {
      const status = await fetchJson<BankingStatus>('/api/banking/status', {
        headers: { Authorization: `Bearer ${token}` },
      })
      setBankingStatus(status)
      setBankingError('')
    } catch (error) {
      setBankingError(error instanceof Error ? error.message : 'Could not load connected bank data.')
    }
  }

  const exchangeBankPublicToken = async (publicToken: string, institutionName: string) => {
    const token = getStoredToken()
    if (!token) return
    setBankingBusy(true)
    setBankingError('')
    setBankingMessage('')
    try {
      const result = await fetchJson<{ connected: boolean; syncStatus: string; message?: string }>('/api/banking/exchange', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ publicToken, institutionName }),
      })
      sessionStorage.removeItem('grounded-plaid-link-token')
      setBankingMessage(result.message || `${institutionName || 'Your bank'} is connected. Transactions are being categorized.`)
      await Promise.all([loadBankingStatus(), loadDashboardNow(), loadNotifications()])
    } catch (error) {
      setBankingError(error instanceof Error ? error.message : 'Could not complete this bank connection.')
      sessionStorage.removeItem('grounded-plaid-link-token')
    } finally {
      setBankingBusy(false)
    }
  }
  exchangeBankTokenRef.current = exchangeBankPublicToken

  const openPlaidLink = async (receivedRedirectUri?: string) => {
    const authToken = getStoredToken()
    if (!authToken) return
    setBankingBusy(true)
    setBankingError('')
    try {
      const pendingLinkToken = receivedRedirectUri ? sessionStorage.getItem('grounded-plaid-link-token') : null
      const { linkToken } = pendingLinkToken
        ? { linkToken: pendingLinkToken }
        : await fetchJson<{ linkToken: string }>('/api/banking/link-token', {
            method: 'POST',
            headers: { Authorization: `Bearer ${authToken}` },
            body: JSON.stringify({ consent: bankConsent }),
          })
      sessionStorage.setItem('grounded-plaid-link-token', linkToken)
      await loadPlaidLinkSdk()
      if (!window.Plaid) throw new Error('Secure bank connection did not load.')
      const handler = window.Plaid.create({
        token: linkToken,
        ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
        onSuccess: (publicToken, metadata) => {
          const url = new URL(window.location.href)
          url.searchParams.delete('oauth_state_id')
          window.history.replaceState({}, '', url)
          void exchangeBankTokenRef.current(publicToken, metadata.institution?.name || 'Financial institution')
        },
        onExit: (error) => {
          sessionStorage.removeItem('grounded-plaid-link-token')
          if (error?.error_message) setBankingError(error.error_message)
          setBankingBusy(false)
        },
      })
      handler.open()
    } catch (error) {
      sessionStorage.removeItem('grounded-plaid-link-token')
      setBankingError(error instanceof Error ? error.message : 'Could not open secure bank connection.')
      setBankingBusy(false)
    }
  }

  const syncBankTransactions = async () => {
    const token = getStoredToken()
    if (!token) return
    setBankingBusy(true)
    setBankingError('')
    setBankingMessage('')
    try {
      const result = await fetchJson<{ results: Array<{ institutionName: string; addedCount?: number; error?: string }> }>('/api/banking/sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const failed = result.results.filter((item) => item.error)
      setBankingMessage(failed.length
        ? `${failed.length} bank connection(s) could not be synced. Other connections were updated.`
        : 'Your bank transactions and balances are up to date.')
      if (failed.length) setBankingError(failed.map((item) => `${item.institutionName}: ${item.error}`).join(' '))
      await Promise.all([loadBankingStatus(), loadDashboardNow()])
    } catch (error) {
      setBankingError(error instanceof Error ? error.message : 'Could not sync bank transactions.')
    } finally {
      setBankingBusy(false)
    }
  }

  const disconnectBank = async (connection: BankConnection) => {
    const token = getStoredToken()
    if (!token) return
    const confirmed = window.confirm(`Disconnect ${connection.institutionName} and remove its imported accounts and transactions from Grounded?`)
    if (!confirmed) return
    setBankingBusy(true)
    setBankingError('')
    try {
      await fetchJson(`/api/banking/connections/${encodeURIComponent(connection.itemId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      setBankingMessage(`${connection.institutionName} was disconnected and its imported data removed.`)
      await Promise.all([loadBankingStatus(), loadDashboardNow(), loadNotifications()])
    } catch (error) {
      setBankingError(error instanceof Error ? error.message : 'Could not disconnect this bank.')
    } finally {
      setBankingBusy(false)
    }
  }

  useEffect(() => {
    if (!isAuthenticated || activeTab !== 'Money') return
    void loadBankingStatus()
    const url = new URL(window.location.href)
    const oauthRedirect = url.searchParams.has('oauth_state_id')
    const savedLinkToken = sessionStorage.getItem('grounded-plaid-link-token')
    if (oauthRedirect && savedLinkToken) {
      void openPlaidLink(url.href)
    }
  }, [isAuthenticated, activeTab])

  const updateProfile = async () => {
    const token = getStoredToken()
    if (!token) return

    await fetchJson('/api/profile', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: form.name,
        monthlyIncome: form.monthlyIncome,
        currentMoney: form.currentMoney,
        fixedExpenses: form.fixedExpenses,
        plannedSpending: form.plannedSpending,
        savingsAllocation: form.savingsAllocation,
        trackingMode: form.trackingMode,
        focusAreas: form.focusAreas,
      }),
    })

    await loadDashboardNow()
    setShowOnboarding(false)
  }

  const loadDashboardNow = async () => {
    const token = getStoredToken()
    if (!token) return

    const response = await fetchJson<DashboardData>('/api/dashboard', {
      headers: { Authorization: `Bearer ${token}` },
    })
    setDashboard(response)
  }

  const refreshBillingStatus = async () => {
    const token = getStoredToken()
    if (!token) return
    setBillingError('')
    try {
      const response = await fetchJson<BillingStatus>('/api/billing/status', {
        headers: { Authorization: `Bearer ${token}` },
      })
      setBilling(response)
      setBillingMessage(response.plan === 'plus' ? 'Grounded Plus is active.' : 'Your account is on the Free plan.')
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : 'Could not load billing status.')
    }
  }

  const startCheckout = async (interval: 'monthly' | 'annual') => {
    const token = getStoredToken()
    if (!token) return
    setBillingBusy(true)
    setBillingError('')
    try {
      const checkout = await fetchJson<{ url: string }>('/api/billing/checkout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ interval }),
      })
      window.location.assign(checkout.url)
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : 'Could not start checkout.')
    } finally {
      setBillingBusy(false)
    }
  }

  const openBillingPortal = async () => {
    const token = getStoredToken()
    if (!token) return
    setBillingBusy(true)
    setBillingError('')
    try {
      const portal = await fetchJson<{ url: string }>('/api/billing/portal', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      window.location.assign(portal.url)
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : 'Could not open the billing portal.')
    } finally {
      setBillingBusy(false)
    }
  }

  useEffect(() => {
    if (activeTab !== 'Insights' || billing.plan !== 'plus') return
    const token = getStoredToken()
    if (!token) return
    let cancelled = false
    fetchJson<PremiumInsights>('/api/premium/insights', {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => {
      if (!cancelled) setPremiumInsights(response)
    }).catch((error: unknown) => {
      if (!cancelled) setBillingError(error instanceof Error ? error.message : 'Could not load premium insights.')
    })
    return () => { cancelled = true }
  }, [activeTab, billing.plan])

  const exportUserData = async () => {
    const token = getStoredToken()
    if (!token) return

    const data = await fetchJson('/api/data/export', {
      headers: { Authorization: `Bearer ${token}` },
    })

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'grounded-export.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const deleteAccount = async () => {
    const token = getStoredToken()
    if (!token) return

    const confirmed = window.confirm('This will permanently delete your Grounded account and all stored financial data. Continue?')
    if (!confirmed) return

    await fetchJson('/api/data/delete', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

    localStorage.removeItem('grounded-token')
    setDashboard(null)
    setIsAuthenticated(false)
    setAuthMode('signup')
    setShowOnboarding(false)
    setAuthError('Your account was deleted. Please create a new account to continue.')
  }

  const createManualAccount = async () => {
    const token = getStoredToken()
    if (!token) return
    setAccountError('')
    try {
      await fetchJson('/api/accounts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(accountDraft),
      })
      setAccountDraft({ name: '', type: 'Checking', balance: 0 })
      setShowAccountForm(false)
      await loadDashboardNow()
      await loadNotifications()
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : 'Could not add this manual account.')
    }
  }

  const createTask = async () => {
    const token = getStoredToken()
    if (!token || !taskDraft.title.trim()) return

    await fetchJson('/api/tasks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(taskDraft),
    })

    setShowTaskForm(false)
    setTaskDraft({ title: '', category: 'Money', due: 'Tomorrow', priority: 'Medium' })
    await loadDashboardNow()
  }

  const createGoal = async () => {
    const token = getStoredToken()
    if (!token || !goalDraft.name.trim()) return

    await fetchJson('/api/goals', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(goalDraft),
    })

    setShowGoalForm(false)
    setGoalDraft({ name: '', target: 0, date: '', contribution: '' })
    await loadDashboardNow()
  }

  const createTransaction = async () => {
    const token = getStoredToken()
    if (!token) return

    await fetchJson('/api/transactions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(transactionDraft),
    })

    setShowTransactionForm(false)
    setTransactionDraft({ description: '', amount: 0, category: '', type: 'Expense' })
    await loadDashboardNow()
  }

  const toggleTaskComplete = async (taskId?: number) => {
    const token = getStoredToken()
    if (!token || taskId === undefined) return
    await fetchJson(`/api/tasks/${taskId}/toggle`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    })
    await loadDashboardNow()
  }

  const createBill = async () => {
    const token = getStoredToken()
    if (!token || !billDraft.name.trim()) return

    await fetchJson('/api/bills', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(billDraft),
    })

    setShowBillForm(false)
    setBillDraft({
      name: '',
      amount: 0,
      frequency: 'Monthly',
      dueDate: '',
      category: '',
      isFixed: true,
      isEstimated: false,
      active: true,
    })
    await loadDashboardNow()
  }

  const createIncomeEntry = async () => {
    const token = getStoredToken()
    if (!token || !incomeDraft.source.trim()) return

    await fetchJson('/api/income', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(incomeDraft),
    })

    setShowIncomeForm(false)
    setIncomeDraft({
      source: '',
      amount: 0,
      frequency: 'Monthly',
      nextDate: '',
      isVariable: false,
      notes: '',
    })
    await loadDashboardNow()
  }

  const createSubscription = async () => {
    const token = getStoredToken()
    if (!token || !subscriptionDraft.merchant.trim()) return

    await fetchJson('/api/subscriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(subscriptionDraft),
    })

    setShowSubscriptionForm(false)
    setSubscriptionDraft({
      merchant: '',
      amount: 0,
      frequency: 'Monthly',
      nextDate: '',
      status: 'Active',
    })
    await loadDashboardNow()
  }

  const nextStep = () => setOnboardingStep((prev) => Math.min(prev + 1, 4))
  const previousStep = () => setOnboardingStep((prev) => Math.max(prev - 1, 0))

  const renderOnboarding = () => (
    <div className="onboarding-shell">
      <div className="onboarding-card">
        {onboardingStep === 0 && (
          <>
            <img src="/grounded-logo-with-bg.png" alt="Grounded logo" className="brand-logo brand-logo--hero" />
            <h2>Get grounded. Stay grounded.</h2>
            <p className="supporting-copy center">Your money doesn’t have to be complicated.</p>
            <button type="button" className="primary-button" onClick={nextStep}>Get started</button>
          </>
        )}

        {onboardingStep === 1 && (
          <>
            <h2>What do you want help with?</h2>
            <div className="option-grid">
              {onboardingGoals.map((goal) => {
                const selected = form.focusAreas.includes(goal)
                return (
                  <button
                    key={goal}
                    type="button"
                    className={selected ? 'choice-chip active' : 'choice-chip'}
                    onClick={() => toggleFocusArea(goal)}
                  >
                    {goal}
                  </button>
                )
              })}
            </div>
            <div className="wizard-actions">
              <button type="button" className="ghost-button" onClick={previousStep}>Back</button>
              <button type="button" className="primary-button" onClick={nextStep}>Continue</button>
            </div>
          </>
        )}

        {onboardingStep === 2 && (
          <>
            <h2>How do you want to track your money?</h2>
            <div className="mode-grid">
              {(['Manual', 'Automatic', 'Hybrid'] as TrackingMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={form.trackingMode === mode ? 'mode-card active' : 'mode-card'}
                  onClick={() => handleInputChange('trackingMode', mode)}
                >
                  <strong>{mode}</strong>
                  <span>
                    {mode === 'Manual' && 'You enter your numbers and review them regularly.'}
                    {mode === 'Automatic' && 'Grounded keeps up with your transactions and account activity.'}
                    {mode === 'Hybrid' && 'Automatic updates plus manual checks for your essentials.'}
                  </span>
                </button>
              ))}
            </div>
            <div className="wizard-actions">
              <button type="button" className="ghost-button" onClick={previousStep}>Back</button>
              <button type="button" className="primary-button" onClick={nextStep}>Continue</button>
            </div>
          </>
        )}

        {onboardingStep === 3 && (
          <>
            <h2>Tell us about your money snapshot.</h2>
            <div className="field-grid">
              <label className="field">
                <span>Monthly income</span>
                <input type="number" value={form.monthlyIncome} onChange={(event) => handleInputChange('monthlyIncome', Number(event.target.value))} />
              </label>
              <label className="field">
                <span>Current money</span>
                <input type="number" value={form.currentMoney} onChange={(event) => handleInputChange('currentMoney', Number(event.target.value))} />
              </label>
              <label className="field">
                <span>Fixed expenses</span>
                <input type="number" value={form.fixedExpenses} onChange={(event) => handleInputChange('fixedExpenses', Number(event.target.value))} />
              </label>
              <label className="field">
                <span>Planned spending</span>
                <input type="number" value={form.plannedSpending} onChange={(event) => handleInputChange('plannedSpending', Number(event.target.value))} />
              </label>
              <label className="field">
                <span>Reserved savings</span>
                <input type="number" value={form.savingsAllocation} onChange={(event) => handleInputChange('savingsAllocation', Number(event.target.value))} />
              </label>
              <label className="field">
                <span>Name</span>
                <input type="text" value={form.name} onChange={(event) => handleInputChange('name', event.target.value)} />
              </label>
            </div>
            <div className="wizard-actions">
              <button type="button" className="ghost-button" onClick={previousStep}>Back</button>
              <button type="button" className="primary-button" onClick={nextStep}>Review plan</button>
            </div>
          </>
        )}

        {onboardingStep === 4 && (
          <>
            <h2>You’re grounded.</h2>
            <div className="summary-grid">
              <div className="summary-pill">
                <span>Monthly income</span>
                <strong>{formatCurrency(form.monthlyIncome)}</strong>
              </div>
              <div className="summary-pill">
                <span>Fixed expenses</span>
                <strong>{formatCurrency(form.fixedExpenses)}</strong>
              </div>
              <div className="summary-pill">
                <span>Planned spending</span>
                <strong>{formatCurrency(form.plannedSpending)}</strong>
              </div>
              <div className="summary-pill highlight">
                <span>Safe to spend</span>
                <strong>{formatCurrency(safeToSpend)}</strong>
              </div>
            </div>
            <p className="supporting-copy center">{form.name}, your money is clearer when it’s organized.</p>
            <div className="wizard-actions">
              <button type="button" className="ghost-button" onClick={previousStep}>Back</button>
              <button type="button" className="primary-button" onClick={updateProfile}>Enter Grounded</button>
            </div>
          </>
        )}
      </div>
    </div>
  )

  if (!isAuthenticated) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="brand-block auth-brand">
            <img src="/grounded-logo-with-bg.png" alt="Grounded logo" className="brand-logo brand-logo--auth" />
            <div>
              <div className="brand-name">Grounded</div>
              <span className="brand-tag">Get grounded. Stay grounded.</span>
            </div>
          </div>

          <form onSubmit={handleAuthSubmit} className="auth-form">
            {authMode !== 'forgot' && authMode !== 'reset' && (
              <div className="auth-toggle">
                <button type="button" className={authMode === 'signup' ? 'toggle-button active' : 'toggle-button'} onClick={() => { setAuthMode('signup'); setAuthError(''); setAuthMessage('') }}>Sign up</button>
                <button type="button" className={authMode === 'login' ? 'toggle-button active' : 'toggle-button'} onClick={() => { setAuthMode('login'); setAuthError(''); setAuthMessage('') }}>Log in</button>
              </div>
            )}

            {authMode === 'signup' && (
              <label className="field">
                <span>Name</span>
                <input autoComplete="name" maxLength={80} required value={authForm.name} onChange={(event) => setAuthForm((prev) => ({ ...prev, name: event.target.value }))} />
              </label>
            )}

            <label className="field">
              <span>Email</span>
              <input autoComplete="email" maxLength={254} required type="email" value={authForm.email} onChange={(event) => setAuthForm((prev) => ({ ...prev, email: event.target.value }))} />
            </label>

            {authMode !== 'forgot' && (
              <label className="field">
                <span>Password{authMode === 'reset' ? ' (new password)' : ''}</span>
                <input autoComplete={authMode === 'signup' || authMode === 'reset' ? 'new-password' : 'current-password'} maxLength={72} minLength={authMode === 'signup' || authMode === 'reset' ? 12 : 1} required type="password" value={authForm.password} onChange={(event) => setAuthForm((prev) => ({ ...prev, password: event.target.value }))} />
              </label>
            )}

            {authError && <div className="auth-error">{authError}</div>}
            {authMessage && <div className="auth-success" role="status">{authMessage}</div>}

            <button type="submit" className="primary-button wide" disabled={authBusy}>
              {authBusy ? 'Please wait…' : authMode === 'signup' ? 'Create account' : authMode === 'login' ? 'Log in' : authMode === 'forgot' ? 'Send reset link' : 'Reset password'}
            </button>
            {authMode === 'login' && <button type="button" className="text-button" onClick={() => { setAuthMode('forgot'); setAuthError(''); setAuthMessage('') }}>Forgot password?</button>}
            {(authMode === 'forgot' || authMode === 'reset') && <button type="button" className="text-button" onClick={() => { setAuthMode('login'); setAuthError(''); setAuthMessage('') }}>Back to log in</button>}
            {authMode === 'signup' && <p className="auth-hint">In production, we'll email you a verification link before your account can be used.</p>}
            {googleClientId && authMode !== 'forgot' && authMode !== 'reset' && (
              <>
                <div className="auth-divider"><span>or</span></div>
                <div ref={googleButtonRef} className="google-signin-button" aria-label="Sign in with Google" />
              </>
            )}
          </form>
        </div>
      </div>
    )
  }

  const tasks = dashboard?.tasks ?? []
  const goals = dashboard?.goals ?? []
  const accounts = dashboard?.accounts ?? []
  const bills = dashboard?.bills ?? []
  const incomes = dashboard?.incomes ?? []
  const subscriptions = dashboard?.subscriptions ?? []

  const recurringBillsTotal = bills.reduce((sum, item) => sum + Number(item.amount || 0), 0)
  const monthlyIncomeTotal = incomes.reduce((sum, item) => sum + Number(item.amount || 0), 0)
  const subscriptionTotal = subscriptions.reduce((sum, item) => sum + Number(item.amount || 0), 0)
  const canCreateGoal = billing.plan === 'plus' || goals.length < 3

  return (
    <div className="app-shell">
      {showOnboarding ? (
        renderOnboarding()
      ) : (
        <>
          <aside className="sidebar">
            <div className="brand-block">
              <img src="/grounded-logo-no-bg.png" alt="Grounded logo" className="brand-logo brand-logo--sidebar" />
              <div>
                <div className="brand-name">Grounded</div>
                <span className="brand-tag">Get grounded. Stay grounded.</span>
              </div>
            </div>

            <nav className="sidebar-nav" aria-label="Main navigation">
              {navItems.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={activeTab === item ? 'nav-item active' : 'nav-item'}
                  onClick={() => setActiveTab(item)}
                >
                  <span>{item}</span>
                  {item === 'Notifications' && unreadNotificationCount > 0 && (
                    <span className="notification-count">{unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}</span>
                  )}
                </button>
              ))}
            </nav>

            <div className="sidebar-footer">
              <button type="button" className="primary-button wide" onClick={() => setActiveTab('Insights')}>Ask Grounded</button>
              <button type="button" className="ghost-button wide logout-button" onClick={logout}>Log out</button>
            </div>
          </aside>

          <main className="content">
            <header className="topbar">
              <div>
                <p className="eyebrow">Good morning 👋</p>
                <h1>Welcome back, {form.name}.</h1>
              </div>
              <div className="topbar-actions">
                <button type="button" className="ghost-button" onClick={() => setShowOnboarding(true)}>Reset My Money</button>
                <button type="button" className="primary-button" onClick={() => setShowTransactionForm((current) => !current)}>Add transaction</button>
              </div>
            </header>

            {loadingDashboard && <div className="loading-message">Loading your money…</div>}

            {activeTab === 'Home' && (
              <>
                <section className="hero-grid">
                  <div className="hero-card financial-card">
                    <div className="mini-label">Total money</div>
                    <div className="total-money">{formatCurrency(totalMoney)}</div>
                    <div className="safe-row">
                      <div>
                        <div className="mini-label">Safe to spend</div>
                        <div className="safe-amount">{formatCurrency(safeToSpend)}</div>
                      </div>
                      <button type="button" className="info-dot" aria-label="Safe to spend info">i</button>
                    </div>
                    <p className="supporting-copy">Money available after upcoming commitments and planned savings.</p>
                  </div>

                  <div className="hero-card assistant-card">
                    <div className="assistant-header">
                      <div>
                        <div className="mini-label">Grounded budget guide</div>
                        <h3>Can I afford this?</h3>
                      </div>
                      <button type="button" className="ghost-button small" onClick={() => setActiveTab('Insights')}>Ask</button>
                    </div>
                    <div className="assistant-price">{formatCurrency(purchaseAmount)} item</div>
                    <p className="supporting-copy">
                      {purchaseAmount > safeToSpend
                        ? 'This would reduce your safe-to-spend below your available cushion.'
                        : 'Yes — this stays within your current safe-to-spend range.'}
                    </p>
                  </div>
                </section>

                <div className="quick-actions">
                  <button type="button" className="primary-button small" onClick={() => setShowTransactionForm((prev) => !prev)}>+ Add Transaction</button>
                  <button type="button" className="ghost-button" onClick={() => { setActiveTab('Money'); setShowBillForm(true) }}>+ Add Bill</button>
                  <button type="button" className="ghost-button" onClick={() => { setActiveTab(canCreateGoal ? 'Goals' : 'Plans'); if (canCreateGoal) setShowGoalForm(true) }}>+ Add Goal</button>
                  <button type="button" className="ghost-button" onClick={() => { setActiveTab('Tasks'); setShowTaskForm(true) }}>+ Add Task</button>
                  <button type="button" className="ghost-button" onClick={() => setActiveTab('Insights')}>Ask Grounded</button>
                </div>

                <section className="panel assistant-panel">
                  <div className="panel-header">
                    <h2>Ask Grounded</h2>
                    <button type="button" className="ghost-button small" onClick={() => setAiPrompt('Can I afford a $150 purchase?')}>Try a prompt</button>
                  </div>
                  <label className="field compact assistant-field">
                    <span>Question</span>
                    <textarea
                      value={aiPrompt}
                      onChange={(event) => setAiPrompt(event.target.value)}
                      rows={3}
                    />
                  </label>
                  <div className="assistant-response">
                    <div className="assistant-badge">Grounded</div>
                    <p>{assistantReply}</p>
                  </div>
                </section>

                {showTransactionForm && (
                  <div className="panel page-panel inline-form-panel">
                    <div className="panel-header">
                      <h2>Add a transaction</h2>
                      <button type="button" className="text-button" onClick={() => setShowTransactionForm(false)}>Close</button>
                    </div>
                    <div className="field-grid">
                      <label className="field">
                        <span>Description</span>
                        <input value={transactionDraft.description} onChange={(event) => setTransactionDraft((prev) => ({ ...prev, description: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span>Category</span>
                        <input value={transactionDraft.category} onChange={(event) => setTransactionDraft((prev) => ({ ...prev, category: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span>Type</span>
                        <select value={transactionDraft.type} onChange={(event) => setTransactionDraft((prev) => ({ ...prev, type: event.target.value as TransactionType }))}>
                          <option value="Expense">Expense</option>
                          <option value="Income">Income</option>
                        </select>
                      </label>
                      <label className="field">
                        <span>Amount</span>
                        <input type="number" value={transactionDraft.amount} onChange={(event) => setTransactionDraft((prev) => ({ ...prev, amount: Number(event.target.value) }))} />
                      </label>
                    </div>
                    <div className="wizard-actions">
                      <button type="button" className="ghost-button" onClick={() => setShowTransactionForm(false)}>Cancel</button>
                      <button type="button" className="primary-button" onClick={createTransaction}>Save</button>
                    </div>
                  </div>
                )}

                <section className="dashboard-grid">
                  <div className="panel chart-panel">
                    <div className="panel-header">
                      <h2>Where your money is going</h2>
                      <div className="segmented-control" aria-label="Time period selector">
                        {['Today', 'This Week', 'This Month', 'Custom'].map((period) => (
                          <button
                            key={period}
                            type="button"
                            className={selectedPeriod === period ? 'segment active' : 'segment'}
                            onClick={() => setSelectedPeriod(period)}
                          >
                            {period}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="chart-layout">
                      <div className="chart-wrap">
                        <svg viewBox="0 0 200 200" className="donut-chart" role="img" aria-label="Spending breakdown chart">
                          <circle cx="100" cy="100" r={72} className="chart-track" />
                          {chartSegments.map((segment, index) => {
                            const total = chartSegments.reduce((sum, item) => sum + item.value, 0) || 1
                            const circumference = 2 * Math.PI * 72
                            const dash = (segment.value / total) * circumference
                            const offset = chartSegments.slice(0, index).reduce((sum, item) => sum + (item.value / total) * circumference, 0)
                            return (
                              <circle
                                key={segment.label}
                                cx="100"
                                cy="100"
                                r={72}
                                className="chart-segment"
                                stroke={segment.color}
                                strokeDasharray={`${dash} ${circumference - dash}`}
                                strokeDashoffset={-offset}
                              />
                            )
                          })}
                        </svg>
                        <div className="chart-center">
                          <span>Spent</span>
                          <strong>{formatCurrency(chartSegments.reduce((sum, item) => (item.label === 'Available' ? sum : sum + item.value), 0))}</strong>
                        </div>
                      </div>

                      <div className="legend">
                        {chartSegments.map((entry) => (
                          <div key={entry.label} className="legend-item">
                            <span className="legend-swatch" style={{ background: entry.color }} />
                            <span>{entry.label}</span>
                            <strong>{formatCurrency(entry.value)}</strong>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="panel forecast-panel">
                    <div className="panel-header">
                      <h2>Money forecast</h2>
                      <span className={`weather-badge ${weatherState.toLowerCase()}`}>{weatherState}</span>
                    </div>
                    <div className="forecast-main">{formatCurrency(projectedBalance)}</div>
                    <div className="forecast-meta">Planning estimate based on values you entered</div>
                    <p className="supporting-copy">
                      Assumes {formatCurrency(form.monthlyIncome)} manually entered monthly income and {formatCurrency(form.fixedExpenses + form.plannedSpending + form.savingsAllocation)} in planned commitments. Connected bank balances and transactions are shown separately in Money.
                    </p>
                  </div>
                </section>

                <section className="bottom-grid">
                  <div className="panel">
                    <div className="panel-header">
                      <h2>Today</h2>
                    </div>
                    <ul className="task-list">
                      {(tasks || []).slice(0, 3).map((task) => (
                        <li key={task.id ?? task.title} className={task.completed ? 'done' : ''}>
                          <span className="check" aria-hidden="true" />
                          <div>
                            <strong>{task.title}</strong>
                            <small>{task.category}</small>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="panel">
                    <div className="panel-header">
                      <h2>What If?</h2>
                    </div>
                    <div className="whatif-panel">
                      <label className="field compact">
                        <span>Purchase amount</span>
                        <input type="range" min="0" max="500" step="25" value={purchaseAmount} onChange={(event) => setPurchaseAmount(Number(event.target.value))} />
                        <div className="range-value">{formatCurrency(purchaseAmount)}</div>
                      </label>
                      <div className="whatif-result">
                        <strong>Safe-to-spend after purchase:</strong>
                        <span>{formatCurrency(postPurchaseBalance)}</span>
                      </div>
                      <p className="supporting-copy">Your current safe-to-spend sits at {formatCurrency(safeToSpend)} before this change.</p>
                    </div>
                  </div>
                </section>
              </>
            )}

            {activeTab === 'Money' && (
              <section className="panel page-panel">
                <div className="panel-header">
                  <h2>Money overview</h2>
                  <button type="button" className="primary-button" onClick={() => setShowAccountForm((visible) => !visible)}>Add manual account</button>
                </div>
                <p className="account-sync-note">Manual tracking only. Grounded does not connect to banks or request bank login details.</p>

                {showAccountForm && (
                  <div className="inline-form-panel">
                    <div className="field-grid">
                      <label className="field">
                        <span>Account label</span>
                        <input maxLength={100} value={accountDraft.name} onChange={(event) => setAccountDraft((prev) => ({ ...prev, name: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span>Account type</span>
                        <select value={accountDraft.type} onChange={(event) => setAccountDraft((prev) => ({ ...prev, type: event.target.value }))}>
                          <option>Checking</option>
                          <option>Savings</option>
                          <option>Credit card</option>
                          <option>Cash</option>
                          <option>Investment</option>
                          <option>Other</option>
                        </select>
                      </label>
                      <label className="field">
                        <span>Current balance</span>
                        <input type="number" step="0.01" value={accountDraft.balance} onChange={(event) => setAccountDraft((prev) => ({ ...prev, balance: Number(event.target.value) }))} />
                      </label>
                    </div>
                    {accountError && <p className="auth-error" role="alert">{accountError}</p>}
                    <p className="supporting-copy">Do not enter bank passwords or full card/account numbers. This balance will not sync automatically.</p>
                    <div className="wizard-actions">
                      <button type="button" className="ghost-button" onClick={() => setShowAccountForm(false)}>Cancel</button>
                      <button type="button" className="primary-button" onClick={createManualAccount}>Save manual account</button>
                    </div>
                  </div>
                )}

                <div className="account-grid">
                  {accounts.length === 0 && <p className="supporting-copy">No manually tracked accounts yet. Add one above or enter balances in your profile.</p>}
                  {accounts.map((account) => (
                    <article key={account.id ?? account.name} className="account-card">
                      <div className="account-topline">
                        <strong>{account.name}</strong>
                        <span className={account.status === 'Connected' ? 'status connected' : 'status manual'}>{account.status}</span>
                      </div>
                      <div className="account-balance">{formatCurrency(account.balance)}</div>
                      <div className="account-type">{account.type}</div>
                      <div className="account-footer">Last updated {account.lastUpdated}</div>
                    </article>
                  ))}
                </div>

                <section className="bank-connect-panel">
                  <div className="panel-header">
                    <div>
                      <h3>Automatic bank syncing</h3>
                      <p className="supporting-copy">Securely connect through Plaid to import balances and categorize transactions.</p>
                    </div>
                    {bankingStatus.connections.length > 0 && (
                      <button type="button" className="ghost-button" disabled={bankingBusy} onClick={syncBankTransactions}>
                        {bankingBusy ? 'Syncing…' : 'Sync now'}
                      </button>
                    )}
                  </div>

                  {!bankingStatus.enabled ? (
                    <p className="supporting-copy">Bank linking is not configured for this app yet. Plaid production credentials and a bank-token encryption key are required before users can connect institutions.</p>
                  ) : (
                    <>
                      <p className="supporting-copy">
                        Grounded never sees or stores your bank password. Plaid handles authorization; Grounded receives only accounts and transactions you approve. Syncs run periodically and when you request them, subject to each bank’s update schedule.
                      </p>
                      <label className="bank-consent">
                        <input type="checkbox" checked={bankConsent} onChange={(event) => setBankConsent(event.target.checked)} />
                        <span>I authorize Grounded to import balances and transactions for accounts I select. I can disconnect at any time.</span>
                      </label>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={!bankConsent || bankingBusy}
                        onClick={() => void openPlaidLink()}
                      >
                        {bankingBusy ? 'Connecting…' : 'Connect a bank securely'}
                      </button>
                    </>
                  )}
                  {bankingMessage && <p className="banking-message" role="status">{bankingMessage}</p>}
                  {bankingError && <p className="auth-error" role="alert">{bankingError}</p>}
                  {bankingStatus.connections.length > 0 && (
                    <div className="bank-connection-list">
                      {bankingStatus.connections.map((connection) => (
                        <div className="bank-connection" key={connection.itemId}>
                          <div>
                            <strong>{connection.institutionName}</strong>
                            <small>
                              {connection.lastSyncedAt
                                ? `Last synced ${new Date(`${connection.lastSyncedAt.replace(' ', 'T')}Z`).toLocaleString()}`
                                : 'Waiting for first sync'}
                            </small>
                          </div>
                          <button type="button" className="text-button" disabled={bankingBusy} onClick={() => void disconnectBank(connection)}>
                            Disconnect
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {dashboard?.transactions.some((transaction) => transaction.source === 'bank') && (
                  <section className="bank-transactions">
                    <div className="panel-header"><h3>Recent bank transactions</h3></div>
                    <div className="bank-transaction-list">
                      {dashboard.transactions.filter((transaction) => transaction.source === 'bank').slice(0, 10).map((transaction) => (
                        <article className="bank-transaction" key={transaction.id}>
                          <div>
                            <strong>{transaction.description}</strong>
                            <small>{transaction.category} · {new Date(`${transaction.created_at.replace(' ', 'T')}Z`).toLocaleDateString()}</small>
                          </div>
                          <strong className={transaction.type === 'Expense' ? 'expense-amount' : transaction.type === 'Income' ? 'income-amount' : 'transfer-amount'}>
                            {transaction.type === 'Expense' ? '−' : transaction.type === 'Income' ? '+' : '↔'}{formatCurrency(transaction.amount)}
                          </strong>
                        </article>
                      ))}
                    </div>
                  </section>
                )}

                <div className="finance-summary-grid">
                  <div className="panel" style={{ padding: '1rem' }}>
                    <div className="mini-label">Recurring bills</div>
                    <div className="forecast-main" style={{ fontSize: '1.8rem', margin: '0.5rem 0' }}>{formatCurrency(recurringBillsTotal)}</div>
                    <p className="supporting-copy">Across {bills.length} active bills</p>
                  </div>
                  <div className="panel" style={{ padding: '1rem' }}>
                    <div className="mini-label">Monthly income</div>
                    <div className="forecast-main" style={{ fontSize: '1.8rem', margin: '0.5rem 0' }}>{formatCurrency(monthlyIncomeTotal)}</div>
                    <p className="supporting-copy">From {incomes.length} sources</p>
                  </div>
                  <div className="panel" style={{ padding: '1rem' }}>
                    <div className="mini-label">Subscriptions</div>
                    <div className="forecast-main" style={{ fontSize: '1.8rem', margin: '0.5rem 0' }}>{formatCurrency(subscriptionTotal)}</div>
                    <p className="supporting-copy">Across {subscriptions.length} services</p>
                  </div>
                </div>

                <div className="money-lists-grid">
                  <div className="panel" style={{ padding: '1rem' }}>
                    <div className="panel-header"><h3>Bills</h3></div>
                    {bills.length === 0 ? (
                      <p className="supporting-copy">No bills added yet.</p>
                    ) : (
                      <ul className="task-list" style={{ marginTop: '0.5rem' }}>
                        {bills.slice(0, 4).map((bill) => (
                          <li key={bill.id ?? bill.name}>
                            <span className="check" aria-hidden="true" />
                            <div>
                              <strong>{bill.name}</strong>
                              <small>{bill.category}</small>
                            </div>
                            <strong>{formatCurrency(bill.amount)}</strong>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="panel" style={{ padding: '1rem' }}>
                    <div className="panel-header"><h3>Income</h3></div>
                    {incomes.length === 0 ? (
                      <p className="supporting-copy">No income streams yet.</p>
                    ) : (
                      <ul className="task-list" style={{ marginTop: '0.5rem' }}>
                        {incomes.slice(0, 4).map((income) => (
                          <li key={income.id ?? income.source}>
                            <span className="check" aria-hidden="true" />
                            <div>
                              <strong>{income.source}</strong>
                              <small>{income.frequency}</small>
                            </div>
                            <strong>{formatCurrency(income.amount)}</strong>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="panel" style={{ padding: '1rem' }}>
                    <div className="panel-header"><h3>Subscriptions</h3></div>
                    {subscriptions.length === 0 ? (
                      <p className="supporting-copy">No subscriptions yet.</p>
                    ) : (
                      <ul className="task-list" style={{ marginTop: '0.5rem' }}>
                        {subscriptions.slice(0, 4).map((entry) => (
                          <li key={entry.id ?? entry.merchant}>
                            <span className="check" aria-hidden="true" />
                            <div>
                              <strong>{entry.merchant}</strong>
                              <small>{entry.status}</small>
                            </div>
                            <strong>{formatCurrency(entry.amount)}</strong>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                <div className="quick-actions" style={{ marginTop: '1rem' }}>
                  <button type="button" className="primary-button small" onClick={() => setShowBillForm((prev) => !prev)}>+ Add bill</button>
                  <button type="button" className="ghost-button" onClick={() => setShowIncomeForm((prev) => !prev)}>+ Add income</button>
                  <button type="button" className="ghost-button" onClick={() => setShowSubscriptionForm((prev) => !prev)}>+ Add subscription</button>
                </div>

                {showBillForm && (
                  <div className="inline-form-panel" style={{ marginTop: '1rem' }}>
                    <div className="panel-header">
                      <h2>Add a bill</h2>
                      <button type="button" className="text-button" onClick={() => setShowBillForm(false)}>Close</button>
                    </div>
                    <div className="field-grid">
                      <label className="field">
                        <span>Bill name</span>
                        <input value={billDraft.name} onChange={(event) => setBillDraft((prev) => ({ ...prev, name: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span>Amount</span>
                        <input type="number" value={billDraft.amount} onChange={(event) => setBillDraft((prev) => ({ ...prev, amount: Number(event.target.value) }))} />
                      </label>
                      <label className="field">
                        <span>Frequency</span>
                        <input value={billDraft.frequency} onChange={(event) => setBillDraft((prev) => ({ ...prev, frequency: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span>Due date</span>
                        <input value={billDraft.dueDate} onChange={(event) => setBillDraft((prev) => ({ ...prev, dueDate: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span>Category</span>
                        <input value={billDraft.category} onChange={(event) => setBillDraft((prev) => ({ ...prev, category: event.target.value }))} />
                      </label>
                    </div>
                    <div className="wizard-actions">
                      <button type="button" className="ghost-button" onClick={() => setShowBillForm(false)}>Cancel</button>
                      <button type="button" className="primary-button" onClick={createBill}>Save bill</button>
                    </div>
                  </div>
                )}

                {showIncomeForm && (
                  <div className="inline-form-panel" style={{ marginTop: '1rem' }}>
                    <div className="panel-header">
                      <h2>Add income</h2>
                      <button type="button" className="text-button" onClick={() => setShowIncomeForm(false)}>Close</button>
                    </div>
                    <div className="field-grid">
                      <label className="field">
                        <span>Source</span>
                        <input value={incomeDraft.source} onChange={(event) => setIncomeDraft((prev) => ({ ...prev, source: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span>Amount</span>
                        <input type="number" value={incomeDraft.amount} onChange={(event) => setIncomeDraft((prev) => ({ ...prev, amount: Number(event.target.value) }))} />
                      </label>
                      <label className="field">
                        <span>Frequency</span>
                        <input value={incomeDraft.frequency} onChange={(event) => setIncomeDraft((prev) => ({ ...prev, frequency: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span>Next date</span>
                        <input value={incomeDraft.nextDate} onChange={(event) => setIncomeDraft((prev) => ({ ...prev, nextDate: event.target.value }))} />
                      </label>
                    </div>
                    <div className="wizard-actions">
                      <button type="button" className="ghost-button" onClick={() => setShowIncomeForm(false)}>Cancel</button>
                      <button type="button" className="primary-button" onClick={createIncomeEntry}>Save income</button>
                    </div>
                  </div>
                )}

                {showSubscriptionForm && (
                  <div className="inline-form-panel" style={{ marginTop: '1rem' }}>
                    <div className="panel-header">
                      <h2>Add subscription</h2>
                      <button type="button" className="text-button" onClick={() => setShowSubscriptionForm(false)}>Close</button>
                    </div>
                    <div className="field-grid">
                      <label className="field">
                        <span>Merchant</span>
                        <input value={subscriptionDraft.merchant} onChange={(event) => setSubscriptionDraft((prev) => ({ ...prev, merchant: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span>Amount</span>
                        <input type="number" value={subscriptionDraft.amount} onChange={(event) => setSubscriptionDraft((prev) => ({ ...prev, amount: Number(event.target.value) }))} />
                      </label>
                      <label className="field">
                        <span>Frequency</span>
                        <input value={subscriptionDraft.frequency} onChange={(event) => setSubscriptionDraft((prev) => ({ ...prev, frequency: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span>Next date</span>
                        <input value={subscriptionDraft.nextDate} onChange={(event) => setSubscriptionDraft((prev) => ({ ...prev, nextDate: event.target.value }))} />
                      </label>
                    </div>
                    <div className="wizard-actions">
                      <button type="button" className="ghost-button" onClick={() => setShowSubscriptionForm(false)}>Cancel</button>
                      <button type="button" className="primary-button" onClick={createSubscription}>Save subscription</button>
                    </div>
                  </div>
                )}
              </section>
            )}

            {activeTab === 'Forecast' && (
              <section className="panel page-panel">
                <div className="panel-header">
                  <h2>Money forecast</h2>
                  <span className={`weather-badge ${weatherState.toLowerCase()}`}>{weatherState}</span>
                </div>
                <div className="forecast-hero">
                  <div className="forecast-main large">{formatCurrency(projectedBalance)}</div>
                  <div className="forecast-meta">Simple monthly estimate from values you entered · not financial advice</div>
                </div>
                <div className="forecast-explainer">
                  <h3>What’s affecting your forecast</h3>
                  <ul>
                    <li>+{formatCurrency(form.monthlyIncome)} manually entered monthly income</li>
                    <li>-{formatCurrency(form.fixedExpenses)} recurring foundations</li>
                    <li>-{formatCurrency(form.plannedSpending)} planned spending</li>
                    <li>-{formatCurrency(form.savingsAllocation)} savings contributions</li>
                  </ul>
                </div>
                <div className="whatif-panel">
                  <label className="field compact">
                    <span>What if I spend</span>
                    <input type="range" min="0" max="500" step="25" value={purchaseAmount} onChange={(event) => setPurchaseAmount(Number(event.target.value))} />
                    <div className="range-value">{formatCurrency(purchaseAmount)}</div>
                  </label>
                  <div className="whatif-result">
                    <strong>Updated estimate:</strong>
                    <span>{formatCurrency(projectedBalance - purchaseAmount)}</span>
                  </div>
                </div>
              </section>
            )}

            {activeTab === 'Goals' && (
              <section className="panel page-panel">
                <div className="panel-header">
                  <h2>Goals</h2>
                  <button type="button" className={canCreateGoal ? 'primary-button' : 'ghost-button'} onClick={() => canCreateGoal ? setShowGoalForm((prev) => !prev) : setActiveTab('Plans')}>
                    {canCreateGoal ? 'Create goal' : 'Upgrade for unlimited'}
                  </button>
                </div>
                {!canCreateGoal && <p className="supporting-copy">The Free plan includes up to 3 goals. Upgrade to Plus to create more.</p>}
                {showGoalForm && (
                  <div className="inline-form-panel">
                    <div className="field-grid">
                      <label className="field">
                        <span>Goal name</span>
                        <input value={goalDraft.name} onChange={(event) => setGoalDraft((prev) => ({ ...prev, name: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span>Target amount</span>
                        <input type="number" value={goalDraft.target} onChange={(event) => setGoalDraft((prev) => ({ ...prev, target: Number(event.target.value) }))} />
                      </label>
                      <label className="field">
                        <span>Due date</span>
                        <input value={goalDraft.date} onChange={(event) => setGoalDraft((prev) => ({ ...prev, date: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span>Contribution</span>
                        <input value={goalDraft.contribution} onChange={(event) => setGoalDraft((prev) => ({ ...prev, contribution: event.target.value }))} />
                      </label>
                    </div>
                    <div className="wizard-actions">
                      <button type="button" className="ghost-button" onClick={() => setShowGoalForm(false)}>Cancel</button>
                      <button type="button" className="primary-button" onClick={createGoal}>Save goal</button>
                    </div>
                  </div>
                )}
                <div className="goal-stack">
                  {goals.map((goal) => {
                    const progress = Math.min((goal.current / goal.target) * 100, 100)
                    return (
                      <div key={goal.id ?? goal.name} className="goal-card">
                        <div className="goal-header">
                          <strong>{goal.name}</strong>
                          <span>{goal.date}</span>
                        </div>
                        <div className="goal-display">{formatCurrency(goal.current)} / {formatCurrency(goal.target)}</div>
                        <div className="goal-bar"><span style={{ width: `${progress}%` }} /></div>
                        <div className="goal-meta">
                          <span>{Math.round(progress)}% complete</span>
                          <span>{goal.contribution}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}

            {activeTab === 'Tasks' && (
              <section className="panel page-panel">
                <div className="panel-header">
                  <h2>Today’s actions</h2>
                  <button type="button" className="primary-button" onClick={() => setShowTaskForm((prev) => !prev)}>Add task</button>
                </div>
                {showTaskForm && (
                  <div className="inline-form-panel">
                    <div className="field-grid">
                      <label className="field">
                        <span>Task title</span>
                        <input value={taskDraft.title} onChange={(event) => setTaskDraft((prev) => ({ ...prev, title: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span>Category</span>
                        <input value={taskDraft.category} onChange={(event) => setTaskDraft((prev) => ({ ...prev, category: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span>Due</span>
                        <input value={taskDraft.due} onChange={(event) => setTaskDraft((prev) => ({ ...prev, due: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span>Priority</span>
                        <select value={taskDraft.priority} onChange={(event) => setTaskDraft((prev) => ({ ...prev, priority: event.target.value as TaskPriority }))}>
                          <option value="High">High</option>
                          <option value="Medium">Medium</option>
                          <option value="Low">Low</option>
                        </select>
                      </label>
                    </div>
                    <div className="wizard-actions">
                      <button type="button" className="ghost-button" onClick={() => setShowTaskForm(false)}>Cancel</button>
                      <button type="button" className="primary-button" onClick={createTask}>Save task</button>
                    </div>
                  </div>
                )}
                <div className="task-stack">
                  {tasks.map((task) => (
                    <div key={task.id ?? task.title} className={task.completed ? 'task-card done' : 'task-card'}>
                      <button type="button" aria-label={`Mark ${task.title} complete`} className="task-check" onClick={() => toggleTaskComplete(task.id)} />
                      <div className="task-body">
                        <strong>{task.title}</strong>
                        <div className="task-meta">
                          <span>{task.category}</span>
                          <span>{task.due}</span>
                          <span className={`priority ${task.priority.toLowerCase()}`}>{task.priority}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {activeTab === 'Insights' && (
              <section className="panel page-panel">
                <div className="panel-header">
                  <h2>Spending insights</h2>
                </div>
                {billing.plan !== 'plus' ? (
                  <div className="info-card">
                    <h3>Unlock Grounded Plus insights</h3>
                    <p>See a breakdown of this month’s expenses by category, calculated from transactions you entered.</p>
                    <button type="button" className="primary-button" onClick={() => setActiveTab('Plans')}>View plans</button>
                  </div>
                ) : (
                  <div className="premium-insights">
                    <p className="supporting-copy">Current month · based on recorded expenses and connected bank transactions, when available.</p>
                    {premiumInsights ? (
                      <>
                        <div className="insight-grid">
                          <div className="insight-card">
                            <span>Recorded spending</span>
                            <strong>{formatCurrency(premiumInsights.totalSpent)}</strong>
                          </div>
                          <div className="insight-card">
                            <span>Expense entries</span>
                            <strong>{premiumInsights.transactionCount}</strong>
                          </div>
                        </div>
                        {premiumInsights.categories.length ? (
                          <div className="forecast-explainer">
                            <h3>Spending by category</h3>
                            <ul>
                              {premiumInsights.categories.map((category) => (
                                <li key={category.category}>
                                  {category.category}: {formatCurrency(category.total)} across {category.transactionCount} entries
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : <p className="supporting-copy">No expense entries recorded this month yet.</p>}
                      </>
                    ) : <p className="supporting-copy">Loading insights…</p>}
                  </div>
                )}
              </section>
            )}

            {activeTab === 'Plans' && (
              <section className="panel page-panel">
                <div className="panel-header">
                  <h2>Plans & billing</h2>
                  <span className={`weather-badge ${billing.plan === 'plus' ? 'grounded' : 'drifting'}`}>
                    {billing.plan === 'plus' ? 'Plus active' : 'Free plan'}
                  </span>
                </div>
                {billingMessage && <p className="supporting-copy" role="status">{billingMessage}</p>}
                {billingError && <p className="auth-error" role="alert">{billingError}</p>}
                <div className="plan-grid">
                  <article className="info-card">
                    <h3>Grounded Free</h3>
                    <p className="plan-price">$0 <span>forever</span></p>
                    <ul>
                      <li>Manual money planning and dashboard</li>
                      <li>Transactions, bills, and subscriptions</li>
                      <li>Up to 3 savings goals</li>
                      <li>Export and delete your data</li>
                    </ul>
                    {billing.plan === 'free' && <strong>Your current plan</strong>}
                  </article>
                  <article className="info-card plan-card-featured">
                    <h3>Grounded Plus</h3>
                    <p className="plan-price">$5.99 <span>/ month</span></p>
                    <p>Or $59.99 per year — save about 17%.</p>
                    <ul>
                      <li>Everything in Free</li>
                      <li>Unlimited savings goals</li>
                      <li>Monthly spending insights by category</li>
                      <li>Secure self-service subscription management</li>
                    </ul>
                    {billing.plan === 'plus' ? (
                      <>
                        {billing.currentPeriodEnd && <p>Current period ends {new Date(billing.currentPeriodEnd).toLocaleDateString()}.</p>}
                        <button type="button" className="ghost-button" disabled={billingBusy} onClick={openBillingPortal}>Manage subscription</button>
                      </>
                    ) : (
                      <div className="plan-actions">
                        <button type="button" className="primary-button" disabled={billingBusy} onClick={() => startCheckout('monthly')}>Choose monthly</button>
                        <button type="button" className="ghost-button" disabled={billingBusy} onClick={() => startCheckout('annual')}>Choose annual</button>
                      </div>
                    )}
                  </article>
                </div>
                <div className="wizard-actions billing-actions">
                  <button type="button" className="ghost-button" disabled={billingBusy} onClick={refreshBillingStatus}>Refresh plan status</button>
                </div>
                <p className="supporting-copy">Payments are processed by Stripe. Your plan changes only after Stripe confirms payment. Prices are in USD; taxes, cancellation terms, and final checkout details are shown by Stripe.</p>
              </section>
            )}

            {activeTab === 'Notifications' && (
              <section className="panel page-panel">
                <div className="panel-header">
                  <div>
                    <h2>Notifications</h2>
                    <p className="supporting-copy">{unreadNotificationCount} unread</p>
                  </div>
                  <button type="button" className="ghost-button" disabled={!unreadNotificationCount} onClick={markAllNotificationsRead}>
                    Mark all as read
                  </button>
                </div>
                <div className={notificationsEmailEnabled ? 'notification-email-state enabled' : 'notification-email-state'}>
                  {notificationsEmailEnabled
                    ? `Email alerts are enabled for ${dashboard?.user.email || 'your account'}.`
                    : 'In-app alerts are enabled. Email delivery is not configured yet; the app owner must add SMTP/Gmail settings.'}
                </div>
                {notificationsError && <p className="auth-error" role="alert">{notificationsError}</p>}
                {notifications.length === 0 ? (
                  <p className="supporting-copy">Important account activity will appear here.</p>
                ) : (
                  <div className="notification-list">
                    {notifications.map((notification) => (
                      <article key={notification.id} className={notification.readAt ? 'notification-card read' : 'notification-card unread'}>
                        <div>
                          <div className="notification-card-heading">
                            <strong>{notification.title}</strong>
                            {!notification.readAt && <span className="notification-unread-label">New</span>}
                          </div>
                          <p>{notification.message}</p>
                          <small>{new Date(`${notification.createdAt.replace(' ', 'T')}Z`).toLocaleString()}</small>
                        </div>
                        {!notification.readAt && (
                          <button type="button" className="text-button" onClick={() => markNotificationRead(notification.id)}>Mark read</button>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}

            {activeTab === 'Profile' && (
              <section className="panel page-panel">
                <div className="panel-header">
                  <h2>Profile</h2>
                </div>
                <div className="profile-card">
                  <div className="profile-pill">{form.name.charAt(0).toUpperCase()}</div>
                  <div>
                    <h3>{form.name}</h3>
                    <p>Currency: USD • Tracking mode: {form.trackingMode}</p>
                  </div>
                </div>
                <div className="profile-settings">
                  <div className="info-row"><span>In-app notifications</span><strong>Enabled</strong></div>
                  <div className="info-row"><span>Email security alerts</span><strong>{notificationsEmailEnabled ? 'Enabled' : 'Not configured'}</strong></div>
                  <div className="info-row"><span>Sign in with Google</span><strong>{googleClientId ? 'Enabled' : 'Not configured'}</strong></div>
                  <div className="info-row"><span>Automatic bank connections</span><strong>{bankingStatus.enabled ? `${bankingStatus.connections.length} connected` : 'Not configured'}</strong></div>
                  <div className="info-row"><span>Privacy center</span><strong>Available</strong></div>
                  <div className="info-row"><span>Data export</span><strong>Available</strong></div>
                </div>
              </section>
            )}

            {activeTab === 'Privacy' && (
              <section className="panel page-panel">
                <div className="panel-header">
                  <h2>Privacy center</h2>
                </div>

                <div className="privacy-grid">
                  <div className="privacy-row">
                    <div>
                      <strong>Financial data</strong>
                      <small>Manual entries are always available. If Plaid is enabled, only bank accounts you authorize are imported; disconnect them in Money at any time.</small>
                    </div>
                  </div>
                  <div className="privacy-row">
                    <div>
                      <strong>Data controls</strong>
                      <small>Export your account data or permanently delete your account and stored data below.</small>
                    </div>
                  </div>
                </div>

                <div className="legal-grid">
                  <div className="info-card">
                    <h3>Data usage</h3>
                    <p>Grounded uses values you enter to estimate safe-to-spend and planning scenarios. These estimates are not financial advice.</p>
                    <ul>
                      <li>When configured, Plaid retrieves only the accounts and transactions you approve. Grounded does not receive or store bank passwords.</li>
                      <li>Manually entered and authorized imported information is stored in this account and used to display your planning views.</li>
                      <li>Use the controls below to export or delete stored account data.</li>
                    </ul>
                  </div>

                  <div className="info-card">
                    <h3>Legal documents</h3>
                    <ul className="legal-links">
                      <li>Privacy Policy: personal data collection, usage, retention, export, and deletion guidance.</li>
                      <li>Terms of Use: account responsibilities, acceptable use, and forecast disclaimers.</li>
                      <li>Copyright: internal reporting workflow for suspected IP infringement.</li>
                    </ul>
                  </div>
                </div>

                <div className="wizard-actions" style={{ marginTop: '1rem' }}>
                  <button type="button" className="primary-button" onClick={exportUserData}>Export my data</button>
                  <button type="button" className="ghost-button" onClick={deleteAccount}>Delete account</button>
                </div>
              </section>
            )}
          </main>
        </>
      )}
    </div>
  )
}

export default App
