/**
 * The MCP stdio server — a hand-rolled, line-delimited JSON-RPC 2.0 loop that
 * implements exactly the protocol subset an analytics tool needs:
 *
 *   initialize / notifications/initialized / ping / tools/list / tools/call
 *
 * Why not the official SDK: zero dependencies is a stated security property of
 * this package (no transitive supply chain, instant npx cold start). The stdio
 * transport is newline-delimited JSON, and this file is the whole protocol
 * surface — small enough to audit in one sitting.
 *
 * @module src/mcp-server.js
 */

import readline from 'node:readline'
import { packageVersion } from './version.js'
import { safeMessage } from './redact.js'
import { buildRegistry } from './tools/index.js'
import { loadConfig } from './config.js'
import { AuthProvider } from './auth.js'
import { AgcClient } from './client.js'

const PROTOCOL_VERSION = '2025-06-18'

/**
 * Run one line-delimited JSON-RPC session over stdin/stdout.
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, env?: NodeJS.ProcessEnv}} [io]
 */
export async function main(io = {}) {
  const input = io.input ?? process.stdin
  const output = io.output ?? process.stdout
  const env = io.env ?? process.env

  const config = loadConfig(env)
  const auth = new AuthProvider(config)
  const client = new AgcClient(config, auth)
  const registry = buildRegistry({ config, auth, client })

  /** Write one JSON-RPC message. Every payload is JSON-safe by construction. */
  const send = message => {
    output.write(`${JSON.stringify(message)}\n`)
  }
  const result = (id, res) => send({ jsonrpc: '2.0', id, result: res })
  const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message: safeMessage(message) } })

  const handle = async message => {
    const { id, method, params } = message
    try {
      switch (method) {
        case 'initialize':
          result(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'agc-analytics-mcp', version: packageVersion },
            instructions:
              'Huawei AppGallery Connect analytics: report trends, crash metrics, review insights and daily/weekly digests. '
              + 'Start with agc_auth_status, then agc_list_apps or agc_get_app_id for appIds. '
              + 'All tools are read-only; nothing is ever published, uploaded or replied on your behalf.',
          })
          return
        case 'notifications/initialized':
          // Acknowledged; see the note in tools/call about not requiring it.
          return
        case 'ping':
          if (id !== undefined) result(id, {})
          return
        case 'tools/list':
          result(id, {
            tools: registry.list().map(tool => ({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              inputSchema: tool.inputSchema,
              annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: tool.network !== false },
            })),
          })
          return
        case 'tools/call': {
          // The `initialized` notification is tracked but not required: a
          // lenient client that skips it should still get its data, and the
          // guard would protect nothing (credentials are per-call anyway).
          const name = params?.name
          const tool = registry.get(name)
          if (tool === undefined) throw new Error(`unknown tool "${name ?? ''}"; call tools/list for the catalogue`)
          const raw = params?.arguments ?? {}
          const parsed = tool.parse(raw)
          const res = await tool.run(parsed)
          // A tool result is content blocks; structured data rides JSON text.
          const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2)
          result(id, { content: [{ type: 'text', text }], isError: false })
          return
        }
        default:
          if (id !== undefined) error(id, -32601, `method not found: ${method ?? '(none)'}`)
      }
    } catch (caught) {
      // Tool failures stay inside tools/call as `isError` results so the model
      // can read the reason and self-correct; only protocol-level damage
      // becomes a JSON-RPC error.
      if (method === 'tools/call') {
        result(id, { content: [{ type: 'text', text: `Error: ${safeMessage(caught)}` }], isError: true })
      } else if (id !== undefined) {
        error(id, -32603, safeMessage(caught))
      }
    }
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  // Denials come back as JSON-RPC errors; a crash exits non-zero via index.js.
  rl.on('line', line => {
    const trimmed = line.trim()
    if (trimmed === '') return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error: line is not valid JSON' } })
      return
    }
    void handle(message)
  })
  rl.on('close', () => {
    output.end()
  })

  console.error(`[agc-analytics] ${packageVersion} ready; credentials=${auth.describe()}; site=${config.site}`)
  await new Promise(resolve => rl.on('close', resolve))
}
