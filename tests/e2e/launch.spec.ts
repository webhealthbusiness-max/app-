import { expect, test } from '@playwright/test'

const dashboard = {
  user: { id: 1, name: 'Synthetic User', email: 'synthetic@example.test' },
  profile: {
    name: 'Synthetic User',
    trackingMode: 'Manual',
    focusAreas: [],
    monthlyIncome: 3200,
    currentMoney: 1250,
    fixedExpenses: 900,
    plannedSpending: 200,
    savingsAllocation: 100,
  },
  safeToSpend: 50,
  totalMoney: 1250,
  projectedBalance: 3250,
  weatherState: 'Unsteady',
  tasks: [],
  goals: [],
  accounts: [],
  transactions: [],
  bills: [],
  incomes: [],
  subscriptions: [],
}

const installApiMocks = async (page: import('@playwright/test').Page) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/auth/login') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'set-cookie': 'grounded_csrf=synthetic-csrf; Path=/; SameSite=Lax' },
        body: JSON.stringify({ user: dashboard.user }),
      })
      return
    }
    if (url.pathname === '/api/auth/password-reset/request') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'If an account exists, you will receive instructions.' }),
      })
      return
    }
    const fixtures: Record<string, unknown> = {
      '/api/dashboard': dashboard,
      '/api/billing/status': { plan: 'free', status: 'free', currentPeriodEnd: null, prices: { monthly: 5.99, annual: 59.99 } },
      '/api/notifications': { notifications: [], unreadCount: 0, emailEnabled: false },
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(fixtures[url.pathname] ?? {}),
    })
  })
}

test('built assets load with browser MIME types and the public signup screen renders', async ({ page }) => {
  const assetResponses: Array<{ path: string; status: number; contentType: string }> = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.origin !== 'http://127.0.0.1:4173') return
    if (/\.(?:js|css)$/.test(url.pathname)) {
      assetResponses.push({ path: url.pathname, status: response.status(), contentType: response.headers()['content-type'] || '' })
    }
  })

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Grounded logo' })).toBeVisible()
  await expect(page.locator('#app-splash')).toHaveCount(0)
  expect(assetResponses.length).toBeGreaterThanOrEqual(2)
  expect(assetResponses.every((asset) => asset.status === 200)).toBe(true)
  expect(assetResponses.some((asset) => asset.path.endsWith('.js') && /javascript|ecmascript/.test(asset.contentType))).toBe(true)
  expect(assetResponses.some((asset) => asset.path.endsWith('.css') && asset.contentType.includes('text/css'))).toBe(true)
})

test('login initializes the dashboard and removes the loading splash', async ({ page }) => {
  await installApiMocks(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await page.getByLabel('Email').fill('synthetic@example.test')
  await page.getByLabel('Password').fill('synthetic-password')
  await page.getByRole('button', { name: 'Log in', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Welcome back, Synthetic User.' })).toBeVisible()
  await expect(page.getByText('$1,250.00').first()).toBeVisible()
  await expect(page.getByText('Loading your money…')).toHaveCount(0)
  await expect(page.locator('#app-splash')).toHaveCount(0)
})

test('password recovery shows the generic success response', async ({ page }) => {
  await installApiMocks(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await page.getByRole('button', { name: 'Forgot password?' }).click()
  await page.getByLabel('Email').fill('synthetic@example.test')
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByRole('status')).toHaveText('If an account exists, you will receive instructions.')
})
