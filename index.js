#!/usr/bin/env node
/**
 * agc-analytics-mcp — entry point.
 *
 * Starts the MCP stdio server. Nothing else: no flags, no REPL, no side
 * effects beyond stderr diagnostics. Errors during startup exit non-zero so
 * an MCP client can tell a dead server from a silent one.
 *
 * `main()` runs only when this file is the process entry point, so importing
 * the module (tests, embedding) never hijacks stdin.
 *
 * @module index.js
 */

import { pathToFileURL } from 'node:url'
import { main } from './src/mcp-server.js'

const isEntryPoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntryPoint) {
  main().catch(error => {
    console.error(`[agc-analytics] startup failed: ${error?.message ?? error}`)
    process.exit(1)
  })
}
