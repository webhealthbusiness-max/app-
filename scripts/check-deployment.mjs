#!/usr/bin/env node
/**
 * Check the public Grounded page and its same-origin assets.
 * Usage: node scripts/check-deployment.mjs https://www.example.com
 * No credentials or authenticated endpoints are used.
 */
const suppliedUrl = process.argv[2] || process.env.DEPLOYMENT_URL
if (!suppliedUrl) {
  console.error('Usage: node scripts/check-deployment.mjs https://your-domain.example')
  process.exit(2)
}

let base
try {
  base = new URL(suppliedUrl)
} catch {
  console.error('Provide a valid absolute URL.')
  process.exit(2)
}
if (!['http:', 'https:'].includes(base.protocol)) {
  console.error('Only HTTP and HTTPS URLs are supported.')
  process.exit(2)
}

const request = async (url) => {
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) })
    return { url, status: response.status, ok: response.ok, contentType: response.headers.get('content-type') || '' }
  } catch (error) {
    return { url, status: 'ERROR', ok: false, error: error instanceof Error ? error.message : 'request failed' }
  }
}

const page = await request(base.href)
console.log(`PAGE ${page.status} ${base.origin}${base.pathname}${page.contentType ? ` [${page.contentType}]` : ''}`)
if (!page.ok) {
  if (page.error) console.log(`  Error: ${page.error}`)
  process.exit(1)
}
if (!page.contentType.includes('text/html')) {
  console.error('Expected HTML from the deployment URL; check the domain and publish target.')
  process.exit(1)
}

let html
try {
  const response = await fetch(base.href, { redirect: 'follow', signal: AbortSignal.timeout(15000) })
  html = await response.text()
} catch (error) {
  console.error(`Could not read page HTML: ${error instanceof Error ? error.message : 'request failed'}`)
  process.exit(1)
}

const references = new Set()
const pattern = /\b(?:src|href)\s*=\s*["']([^"'#]+)["']/gi
for (const match of html.matchAll(pattern)) {
  const raw = match[1].trim()
  if (!raw || /^(?:data:|mailto:|tel:|javascript:)/i.test(raw)) continue
  try {
    const url = new URL(raw, base)
    if (url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol)) continue
    if (/\.(?:js|mjs|css|png|jpe?g|webp|svg|ico|webmanifest|woff2?)(?:$|\?)/i.test(url.pathname)) references.add(url.href)
  } catch {
    // Ignore malformed/non-URL references; report valid same-origin assets only.
  }
}

if (html.includes('/src/main.tsx')) {
  console.error('WARNING: served HTML references /src/main.tsx (Vite source entry), not a built bundle.')
}
if (references.size === 0) {
  console.error('WARNING: no same-origin built assets were discovered in the returned HTML.')
  process.exit(1)
}

let failures = 0
for (const url of references) {
  const result = await request(url)
  const parsed = new URL(url)
  console.log(`ASSET ${result.status} ${parsed.pathname}${result.contentType ? ` [${result.contentType}]` : ''}`)
  if (!result.ok) {
    failures++
    if (result.error) console.log(`  Error: ${result.error}`)
  }
}
console.log(`Checked ${references.size} same-origin asset(s); failures: ${failures}.`)
if (failures > 0) process.exit(1)
