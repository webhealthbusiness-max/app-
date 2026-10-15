import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const checkerPath = fileURLToPath(new URL('../scripts/check-deployment.mjs', import.meta.url))

const runChecker = (url) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [checkerPath, url], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  child.once('error', reject)
  child.once('close', (code) => resolve({ code, stdout, stderr }))
})

const withDeploymentServer = async (t, rejectOrigins, run) => {
  const observedOrigins = []
  const server = createServer((req, res) => {
    const origin = req.headers.origin || ''
    if (origin) observedOrigins.push([req.url, origin])
    if (req.url !== '/' && rejectOrigins) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end('{"error":"Origin not allowed by CORS policy."}')
      return
    }
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">')
      return
    }
    if (req.url === '/assets/app.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
      res.end('export {};')
      return
    }
    if (req.url === '/assets/app.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
      res.end('body { color: black; }')
      return
    }
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}/`
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const result = await runChecker(url)
  return { result, observedOrigins, origin: new URL(url).origin }
}

test('deployment checker catches same-origin CORS rejection for assets and API health', async (t) => {
  const { result, observedOrigins, origin } = await withDeploymentServer(t, true, runChecker)

  assert.equal(result.code, 1)
  assert.match(result.stdout, /ASSET 403 \/assets\/app\.js/)
  assert.match(result.stdout, /ASSET 403 \/assets\/app\.css/)
  assert.match(result.stdout, /API_HEALTH 403 \/api\/health/)
  assert.deepEqual(observedOrigins, [
    ['/assets/app.js', origin],
    ['/assets/app.css', origin],
    ['/api/health', origin],
  ])
})

test('deployment checker accepts built assets and same-origin JSON API health', async (t) => {
  const { result, observedOrigins, origin } = await withDeploymentServer(t, false, runChecker)

  assert.equal(result.code, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /ASSET 200 \/assets\/app\.js \[text\/javascript/)
  assert.match(result.stdout, /ASSET 200 \/assets\/app\.css \[text\/css/)
  assert.match(result.stdout, /API_HEALTH 200 \/api\/health \[application\/json/)
  assert.ok(observedOrigins.every(([, requestOrigin]) => requestOrigin === origin))
})
