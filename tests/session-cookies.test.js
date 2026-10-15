import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { clearSessionCookieHeaders, createSessionCookieHeaders, getCookie, hasValidCsrfProof } from '../server/session-cookies.js'

const secret = 'synthetic-cookie-session-signing-secret-at-least-32-characters'

test('session cookies are HttpOnly and Secure in production with a signed SameSite CSRF cookie', () => {
  const sessionToken = 'synthetic.jwt.token'
  const csrfToken = randomBytes(32).toString('hex')
  const headers = createSessionCookieHeaders({ sessionToken, csrfToken, secret, secure: true })

  assert.match(headers[0], /^grounded_session=synthetic\.jwt\.token;/)
  assert.match(headers[0], /HttpOnly/)
  assert.match(headers[0], /Secure/)
  assert.match(headers[0], /SameSite=Lax/)
  assert.doesNotMatch(headers[1], /HttpOnly/)
  assert.match(headers[1], /^grounded_csrf=[a-f0-9]{64}\.[a-f0-9]{64};/)
  assert.match(headers[1], /Secure/)
  assert.match(clearSessionCookieHeaders({ secure: true })[0], /Max-Age=0/)
})

test('CSRF proof requires matching cookie/header and valid HMAC; duplicate cookies fail closed', () => {
  const csrfCookieHeader = createSessionCookieHeaders({ sessionToken: 'synthetic.jwt.token', csrfToken: 'a'.repeat(64), secret, secure: false })[1]
  const csrfCookie = csrfCookieHeader.split(';')[0].slice('grounded_csrf='.length)
  const request = { headers: { cookie: `grounded_session=jwt; grounded_csrf=${csrfCookie}`, 'x-csrf-token': csrfCookie } }

  assert.equal(getCookie(request, 'grounded_session'), 'jwt')
  assert.equal(hasValidCsrfProof(request, secret), true)
  assert.equal(hasValidCsrfProof({ headers: { ...request.headers, 'x-csrf-token': 'wrong' } }, secret), false)
  assert.equal(hasValidCsrfProof({ headers: { ...request.headers, cookie: 'grounded_csrf=' + 'a'.repeat(64) + '.' + '0'.repeat(64) } }, secret), false)
  assert.equal(getCookie({ headers: { cookie: 'grounded_session=first; grounded_session=second' } }, 'grounded_session'), null)
})
