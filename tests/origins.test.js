import assert from 'node:assert/strict'
import test from 'node:test'
import { assertAppBaseOriginAllowed, parseAllowedOrigins } from '../server/origins.js'

test('development origins retain the documented local defaults', () => {
  assert.deepEqual(parseAllowedOrigins(undefined), [
    'http://localhost:3000',
    'http://localhost:3003',
    'http://localhost:4173',
  ])
})

test('allowed origins must be canonical origins without paths or invalid URLs', () => {
  assert.deepEqual(parseAllowedOrigins('https://grounded.example, https://app.grounded.example'), [
    'https://grounded.example',
    'https://app.grounded.example',
  ])
  assert.throws(() => parseAllowedOrigins('not a url'), /valid origin URLs/)
  assert.throws(() => parseAllowedOrigins('https://grounded.example/'), /canonical HTTP or HTTPS origins/)
  assert.throws(() => parseAllowedOrigins('https://grounded.example/path'), /canonical HTTP or HTTPS origins/)
})

test('production origins require HTTPS and reject loopback hosts', () => {
  assert.deepEqual(parseAllowedOrigins('https://grounded.example', { production: true }), ['https://grounded.example'])
  assert.throws(() => parseAllowedOrigins('http://grounded.example', { production: true }), /must use HTTPS/)
  assert.throws(() => parseAllowedOrigins('https://localhost', { production: true }), /cannot include localhost or loopback hosts/)
  assert.throws(() => parseAllowedOrigins('https://preview.localhost', { production: true }), /cannot include localhost or loopback hosts/)
  assert.throws(() => parseAllowedOrigins('https://127.0.0.2', { production: true }), /cannot include localhost or loopback hosts/)
})

test('APP_BASE_URL must point to an origin enabled for credentialed requests', () => {
  const allowedOrigins = parseAllowedOrigins('https://grounded.example,https://app.grounded.example')
  assert.doesNotThrow(() => assertAppBaseOriginAllowed('https://grounded.example', allowedOrigins))
  assert.throws(
    () => assertAppBaseOriginAllowed('https://wrong-origin.example', allowedOrigins),
    /APP_BASE_URL origin must be included in ALLOWED_ORIGINS/,
  )
})
