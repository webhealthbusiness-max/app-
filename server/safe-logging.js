const SAFE_ERROR_CODE = /^[A-Za-z0-9_-]{1,64}$/

export const getSafeErrorCode = (error, providerCode) => {
  for (const candidate of [providerCode, error?.code, error?.name]) {
    if (typeof candidate === 'string' && SAFE_ERROR_CODE.test(candidate)) return candidate
  }
  return 'UnknownError'
}
