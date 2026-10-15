const MAX_CURRENCY_VALUE = 100000000
const FREQUENCIES = new Set(['Weekly', 'Biweekly', 'Monthly', 'Quarterly', 'Yearly'])
const SUBSCRIPTION_STATUSES = new Set(['Active', 'Paused', 'Cancelled'])

const currencyString = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return value.trim()
  return ''
}

export const parseCurrency = (value) => {
  const input = currencyString(value)
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(input)) return null
  const parsed = Number(input)
  return Number.isFinite(parsed) && parsed <= MAX_CURRENCY_VALUE ? parsed : null
}

export const parseSignedCurrency = (value) => {
  const input = currencyString(value)
  if (!/^-?(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(input)) return null
  const parsed = Number(input)
  return Number.isFinite(parsed) && Math.abs(parsed) <= MAX_CURRENCY_VALUE ? parsed : null
}

export const isValidIsoDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}

export const isAllowedFrequency = (value) => FREQUENCIES.has(value)
export const isAllowedSubscriptionStatus = (value) => SUBSCRIPTION_STATUSES.has(value)
export const isOptionalBoolean = (value) => value === undefined || typeof value === 'boolean'
