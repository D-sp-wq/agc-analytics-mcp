#!/usr/bin/env node
/**
 * Handshake check: starts the real server over stdio the way an MCP client
 * would, and asserts that the protocol surface answers.
 *
 * Used by CI on every platform (no shell quoting tricks), and handy locally:
 *   node scripts/handshake-check.mjs
 *
 * Requires no credentials: `agc_auth_status` is the one tool that never
 * touches the network, so it can always be called.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const child = spawn(process.execPath, [join(root, 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AGC_CLIENT_ID: '', AGC_CLIENT_SECRET: '', AGC_CLIENT_FILE: '', AGC_SERVICE_ACCOUNT_FILE: '' },
})

const messages = []
let buffer = ''
child.stdout.on('data', chunk => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line !== '') {
      try { messages.push(JSON.parse(line)) } catch { /* ignore non-JSON noise on stdout */ }
    }
  }
})

let stderr = ''
child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })

const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)

function waitFor(predicate, what, timeoutMs = 10_000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = messages.find(predicate)
      if (found !== undefined) return resolve(found)
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${what}\nstderr: ${stderr.slice(0, 500)}`))
      setTimeout(tick, 20)
    }
    tick()
  })
}

const failures = []
const ok = (condition, label) => { if (!condition) failures.push(label); console.log(`${condition ? '✔' : '✘'} ${label}`) }

try {
  send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'handshake-check', version: '0' } })
  const init = await waitFor(m => m.id === 1, 'initialize response')
  ok(init.result?.serverInfo?.name === 'agc-analytics-mcp', `serverInfo.name = ${init.result?.serverInfo?.name}`)
  ok(typeof init.result?.serverInfo?.version === 'string', `serverInfo.version = ${init.result?.serverInfo?.version}`)
  ok(typeof init.result?.protocolVersion === 'string', `protocolVersion = ${init.result?.protocolVersion}`)

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  send(2, 'ping', {})
  const pong = await waitFor(m => m.id === 2, 'ping response')

  send(3, 'tools/list', {})
  const list = await waitFor(m => m.id === 3, 'tools/list response')
  const tools = list.result?.tools ?? []
  ok(tools.length === 13, `tools/list exposes ${tools.length} tools (expected 13)`)
  ok(tools.every(t => t.annotations?.readOnlyHint === true), 'every tool is marked read-only')
  ok(tools.every(t => t.inputSchema?.type === 'object'), 'every tool declares an object input schema')
  ok(new Set(tools.map(t => t.name)).size === tools.length, 'tool names are unique')

  send(4, 'tools/call', { name: 'agc_auth_status', arguments: {} })
  const status = await waitFor(m => m.id === 4, 'tools/call response')
  const payload = JSON.parse(status.result?.content?.[0]?.text ?? '{}')
  ok(status.result?.isError === false, 'agc_auth_status succeeds without credentials')
  ok(payload.credentialsLoaded?.apiClient === false, 'reports no credentials configured')
  ok(Array.isArray(payload.hints) && payload.hints.length > 0, 'offers a setup hint')

  send(5, 'tools/call', { name: 'no-such-tool', arguments: {} })
  const unknown = await waitFor(m => m.id === 5, 'unknown-tool response')
  ok(unknown.result?.isError === true, 'unknown tools return an isError result, not a crash')

  void pong
} catch (error) {
  failures.push(error.message)
} finally {
  child.stdin.end()
  setTimeout(() => child.kill(), 500).unref()
}

if (failures.length !== 0) {
  console.error(`\nhandshake check FAILED (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nhandshake check passed')
