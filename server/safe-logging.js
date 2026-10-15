const SAFE_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'EAUTH',
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'EENVELOPE',
  'EMESSAGE',
  'ENOTFOUND',
  'ESOCKET',
  'ETIMEDOUT',
  'INSTITUTION_DOWN',
  'INSTITUTION_NOT_RESPONDING',
  'INTERNAL_SERVER_ERROR',
  'INVALID_API_KEYS',
  'INVALID_CREDENTIALS',
  'INVALID_REQUEST',
  'ITEM_LOGIN_REQUIRED',
  'PRODUCT_NOT_READY',
  'RATE_LIMIT_EXCEEDED',
  'UNAUTHORIZED',
  'AxiosError',
  'Error',
  'PlaidError',
  'StripeAPIError',
  'StripeConnectionError',
  'StripeInvalidRequestError',
])

export const getSafeErrorCode = (error, providerCode) => {
  for (const candidate of [providerCode, error?.code, error?.name]) {
    if (typeof candidate === 'string' && SAFE_ERROR_CODES.has(candidate)) return candidate
  }
  return 'UnknownError'
}
