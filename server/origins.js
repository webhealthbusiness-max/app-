const DEFAULT_DEVELOPMENT_ORIGINS = 'http://localhost:3000,http://localhost:3003,http://localhost:4173'

export const parseAllowedOrigins = (configuredOrigins, { production = false } = {}) => {
  const origins = (configuredOrigins || DEFAULT_DEVELOPMENT_ORIGINS)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  if (origins.length === 0) throw new Error('At least one allowed origin must be configured.')

  const normalized = origins.map((origin) => {
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      throw new Error('ALLOWED_ORIGINS must contain valid origin URLs.')
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('ALLOWED_ORIGINS entries must be canonical HTTP or HTTPS origins without a path.')
    }
    if (production && parsed.protocol !== 'https:') {
      throw new Error('Production ALLOWED_ORIGINS entries must use HTTPS.')
    }
    const loopbackHost = parsed.hostname === 'localhost'
      || parsed.hostname.endsWith('.localhost')
      || /^127(?:\.\d{1,3}){3}$/.test(parsed.hostname)
      || parsed.hostname === '[::1]'
    if (production && loopbackHost) {
      throw new Error('Production ALLOWED_ORIGINS cannot include localhost or loopback hosts.')
    }
    return origin
  })

  return [...new Set(normalized)]
}

export const assertAppBaseOriginAllowed = (appBaseUrl, allowedOrigins) => {
  let origin
  try {
    origin = new URL(appBaseUrl).origin
  } catch {
    throw new Error('APP_BASE_URL must be a valid absolute URL.')
  }
  if (!allowedOrigins.includes(origin)) {
    throw new Error('APP_BASE_URL origin must be included in ALLOWED_ORIGINS.')
  }
}
