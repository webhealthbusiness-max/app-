import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE_NAME = 'grounded_session'
export const CSRF_COOKIE_NAME = 'grounded_csrf'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7

export const getCookie = (req, name) => {
  const matches = String(req.headers.cookie || '').split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
  if (matches.length !== 1) return null
  return matches[0].slice(name.length + 1)
}

const signCsrfToken = (token, secret) => createHmac('sha256', secret).update(token).digest('hex')

export const createSessionCookieHeaders = ({ sessionToken, secret, secure = true, csrfToken = randomBytes(32).toString('hex') }) => {
  if (typeof sessionToken !== 'string' || !sessionToken || typeof secret !== 'string' || secret.length < 32) {
    throw new TypeError('A session token and strong signing secret are required.')
  }
  const secureAttribute = secure ? '; Secure' : ''
  const csrfCookie = `${csrfToken}.${signCsrfToken(csrfToken, secret)}`
  return [
    `${SESSION_COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secureAttribute}`,
    `${CSRF_COOKIE_NAME}=${csrfCookie}; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secureAttribute}`,
  ]
}

export const clearSessionCookieHeaders = ({ secure = true } = {}) => {
  const secureAttribute = secure ? '; Secure' : ''
  return [
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttribute}`,
    `${CSRF_COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0${secureAttribute}`,
  ]
}

export const hasValidCsrfProof = (req, secret) => {
  const cookie = getCookie(req, CSRF_COOKIE_NAME)
  const header = req.headers['x-csrf-token']
  if (!cookie || typeof header !== 'string' || cookie !== header) return false
  const separator = cookie.indexOf('.')
  if (separator !== 64 || !/^[a-f0-9]{64}$/.test(cookie.slice(0, separator))) return false
  const token = cookie.slice(0, separator)
  const suppliedMac = Buffer.from(cookie.slice(separator + 1), 'hex')
  const expectedMac = Buffer.from(signCsrfToken(token, secret), 'hex')
  return suppliedMac.length === expectedMac.length && timingSafeEqual(suppliedMac, expectedMac)
}
