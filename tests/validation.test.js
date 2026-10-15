import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAllowedFrequency, isAllowedSubscriptionStatus, isOptionalBoolean, isValidIsoDate, parseCurrency, parseSignedCurrency } from '../server/validation.js'

test('currency validation rejects excess fractional precision, exponent notation, and out-of-range values', () => {
  assert.equal(parseCurrency(0.29), 0.29)
  assert.equal(parseCurrency('100000000.00'), 100000000)
  assert.equal(parseCurrency('1.001'), null)
  assert.equal(parseCurrency('1e2'), null)
  assert.equal(parseCurrency('-1'), null)
  assert.equal(parseCurrency('100000000.01'), null)
  assert.equal(parseSignedCurrency('-0.29'), -0.29)
  assert.equal(parseSignedCurrency('1.001'), null)
})

test('date and enum validation rejects invalid calendar dates and unsupported values', () => {
  assert.equal(isValidIsoDate('2024-02-29'), true)
  assert.equal(isValidIsoDate('2025-02-29'), false)
  assert.equal(isValidIsoDate('2026-13-01'), false)
  assert.equal(isValidIsoDate('Oct 18'), false)
  assert.equal(isAllowedFrequency('Monthly'), true)
  assert.equal(isAllowedFrequency('Immediately'), false)
  assert.equal(isAllowedSubscriptionStatus('Active'), true)
  assert.equal(isAllowedSubscriptionStatus('Arbitrary'), false)
  assert.equal(isOptionalBoolean(undefined), true)
  assert.equal(isOptionalBoolean(false), true)
  assert.equal(isOptionalBoolean('false'), false)
})
