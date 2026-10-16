/**
 * End-to-end test: spawn the real server binary over stdio and drive the MCP
 * protocol the way a client would — initialize → tools/list → tools/call —
 * with a local mock AGC upstream so the full export → download → parse chain
 * runs against realistic HTTP.
 *
 * The mock server binds 127.0.0.1 and answers `connect-api.cloud.huawei.com`
 * shaped paths; the client's site guard is satisfied by the real hostname via
 * a hosts-file-free trick: the client code reads the base URL from AGC_SITE,
 * so this test monkey-patches nothing — instead it starts the mock and points
 * the site at it through the site table? No: the guard pins the four real
 * hosts. To exercise the full HTTP path without touching /etc/hosts, the e2e
 * below stubs `fetch` inside the child? Not possible cross-process.
 *
 * Resolution: two e2e layers.
 *  1. In-process protocol e2e against src/mcp-server.js main() with custom
 *     streams — covers the wire protocol exactly.
 *  2. HTTP-level mock test that calls the tool functions against a real local
 *     http server through a site-table override (AGC hosts are data, and the
 *     test builds an AgcClient whose baseUrlFor is redirected to the mock).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Buffer } from 'node:buffer'
import { PassThrough } from 'node:stream'
import { main } from '../src/mcp-server.js'
import { loadConfig } from '../src/config.js'
import { AuthProvider } from '../src/auth.js'
import { AgcClient } from '../src/client.js'
import { assertAgcHost } from '../src/sites.js'
import { buildRegistry } from '../src/tools/index.js'

// ── 1. protocol e2e, in process ──────────────────────────────────────────────

test('MCP protocol: initialize, tools/list, unknown tool, tools/call error shape', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const server = main({ input, output, env: {} })
  const lines = []
  let buffer = ''
  output.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let idx
    while ((idx = buffer.indexOf('\n')) !== -1) {
      lines.push(JSON.parse(buffer.slice(0, idx)))
      buffer = buffer.slice(idx + 1)
    }
  })

  const rpc = (id, method, params) => {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  }

  // initialize
  rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  await waitUntil(() => lines.some(m => m.id === 1))
  const init = lines.find(m => m.id === 1)
  assert.equal(init.result.serverInfo.name, 'agc-analytics-mcp')
  assert.ok(init.result.protocolVersion)

  rpc(2, 'notifications/initialized')
  rpc(3, 'tools/list')
  await waitUntil(() => lines.some(m => m.id === 3))
  const tools = lines.find(m => m.id === 3).result.tools
  assert.equal(tools.length, 13)
  assert.ok(tools.every(t => t.annotations.readOnlyHint === true))

  // unknown tool
  rpc(4, 'tools/call', { name: 'nope', arguments: {} })
  await waitUntil(() => lines.some(m => m.id === 4))
  const unknown = lines.find(m => m.id === 4)
  assert.equal(unknown.result.isError, true)
  assert.ok(unknown.result.content[0].text.includes('unknown tool'))

  // tools/call on agc_auth_status without credentials — must succeed with hints
  rpc(5, 'tools/call', { name: 'agc_auth_status', arguments: {} })
  await waitUntil(() => lines.some(m => m.id === 5))
  const status = lines.find(m => m.id === 5)
  assert.equal(status.result.isError, false)
  const payload = JSON.parse(status.result.content[0].text)
  assert.equal(payload.credentialsLoaded.apiClient, false)

  // parse error handling
  input.write('this is not json\n')
  await waitUntil(() => lines.some(m => m.error?.code === -32700))
  input.end()
  await server
})

function waitUntil(condition, timeoutMs = 5000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) resolve()
      else if (Date.now() - start > timeoutMs) reject(new Error('e2e wait timed out'))
      else setTimeout(tick, 10)
    }
    tick()
  })
}

// ── 2. HTTP-level chain: token → export → download → parse, real HTTP ────────

test('full chain over real HTTP: token, export, fileURL download, trend', async (t) => {
  const csv = '日期,下载量\n2026-02-01,111\n2026-02-02,222\n2026-02-03,333\n'
  const seen = { token: 0, report: 0, download: 0 }
  const http = createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body) }
    if (req.url === '/api/oauth2/v1/token') { seen.token++; return send(200, 'application/json', JSON.stringify({ access_token: 'tok-live', expires_in: 3600 })) }
    if (req.url.startsWith('/api/report/')) {
      seen.report++
      if (req.headers.authorization !== 'Bearer tok-live') return send(401, 'application/json', '{"ret":{"code":401,"msg":"unauthorized"}}')
      return send(200, 'application/json', JSON.stringify({ ret: { code: 0 }, fileURL: `http://127.0.0.1:${http.address().port}/file.csv` }))
    }
    if (req.url === '/file.csv') { seen.download++; return send(200, 'text/csv', '\uFEFF' + csv) }
    send(404, 'text/plain', 'not found')
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  // undici keeps connections alive, so a bare close() would hang the runner.
  t.after(() => new Promise(resolve => {
    http.closeAllConnections?.()
    http.close(() => resolve())
  }))
  const port = http.address().port

  // Only AGC_BASE_URL may point the real client at a loopback mock; the site
  // guard and every other safety check stay in force.
  const env = {
    AGC_CLIENT_ID: 'live-id',
    AGC_CLIENT_SECRET: 'live-secret',
    AGC_BASE_URL: `http://127.0.0.1:${port}`,
  }
  const config = loadConfig(env)
  assert.deepEqual(config.problems, [])
  const auth = new AuthProvider(config)
  const client = new AgcClient(config, auth)
  const registry = buildRegistry({ config, auth, client })

  const exported = await registry.get('agc_report_export').run({ appId: 'app1', report: 'harmony-download', startDate: '2026-02-01', endDate: '2026-02-03' })
  assert.equal(exported.rowCount, 3)
  assert.equal(exported.rows[1]['下载量'], '222')

  const trend = await registry.get('agc_report_trend').run({ appId: 'app1', report: 'harmony-download', metric: '下载量', startDate: '2026-02-01', endDate: '2026-02-03' })
  assert.equal(trend.trend.daysCovered, 3)
  assert.equal(trend.trend.lastValue, 333)
  assert.equal(trend.trend.direction, 'up')

  assert.equal(seen.token, 1, 'token fetched once and cached')
  assert.equal(seen.report, 2)
  assert.equal(seen.download, 2)
})

test('without AGC_BASE_URL the client pins to the real AGC host', () => {
  const config = loadConfig({ AGC_CLIENT_ID: 'id', AGC_CLIENT_SECRET: 'secret' })
  assert.equal(config.baseUrl, 'https://connect-api.cloud.huawei.com')
  const client = new AgcClient(config, new AuthProvider(config))
  assert.equal(client.loopback, false)
  assert.equal(client.baseFor(undefined), 'https://connect-api.cloud.huawei.com')
  assert.equal(client.baseFor('sg'), 'https://connect-api-dra.cloud.huawei.com')
  // The backstop that would catch any URL that escaped URL construction.
  assert.throws(() => assertAgcHost('https://evil.example.com/api/report/x'), /non-AGC/)
  assert.throws(() => assertAgcHost('http://connect-api.cloud.huawei.com/api/report/x'), /non-AGC/)
})

test('AGC_BASE_URL refuses anything but https or a loopback mock', () => {
  const rejected = loadConfig({ AGC_BASE_URL: 'http://gateway.corp.example.com' })
  assert.ok(rejected.problems.some(p => p.includes('must use https')), rejected.problems.join('; '))
  assert.equal(rejected.baseUrl, 'https://connect-api.cloud.huawei.com', 'falls back to the real site')

  const garbage = loadConfig({ AGC_BASE_URL: 'not a url' })
  assert.ok(garbage.problems.some(p => p.includes('not a valid URL')))

  const local = loadConfig({ AGC_BASE_URL: 'http://127.0.0.1:8080' })
  assert.deepEqual(local.problems, [])
  assert.equal(local.baseUrl, 'http://127.0.0.1:8080')

  const secureGateway = loadConfig({ AGC_BASE_URL: 'https://agc-gateway.corp.example.com' })
  assert.deepEqual(secureGateway.problems, [])
  assert.equal(secureGateway.baseUrl, 'https://agc-gateway.corp.example.com')
})
