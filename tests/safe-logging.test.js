import assert from 'node:assert/strict'
import test from 'node:test'
import { getSafeErrorCode } from '../server/safe-logging.js'

test('error logging selects only safe provider or error codes', () => {
  assert.equal(getSafeErrorCode({ code: 'ETIMEDOUT', message: 'private@example.test secret details' }), 'ETIMEDOUT')
  assert.equal(getSafeErrorCode({ name: 'StripeConnectionError', message: 'customer and request details' }), 'StripeConnectionError')
  assert.equal(getSafeErrorCode({ message: 'private@example.test secret details' }, 'ITEM_LOGIN_REQUIRED'), 'ITEM_LOGIN_REQUIRED')
  assert.equal(getSafeErrorCode({ code: 'bad code with private@example.test', message: 'sensitive detail' }), 'UnknownError')
})
