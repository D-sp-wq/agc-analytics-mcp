#!/usr/bin/env node
/**
 * Test runner that works on every supported Node version.
 *
 * `node --test "test/**\/*.test.js"` only understands glob patterns from Node
 * 21 onwards — on Node 20 the pattern is taken literally and the run fails
 * before a single test executes (this broke CI on the Node 20 matrix legs).
 * Enumerating the files here keeps one command valid from Node 20 through the
 * current release, on Windows and POSIX alike, with no shell quoting rules.
 *
 *   npm test
 *   node scripts/run-tests.mjs
 */

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const testDir = fileURLToPath(new URL('../test/', import.meta.url))
const files = readdirSync(testDir)
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => join(testDir, name))

if (files.length === 0) {
  console.error('run-tests: no test/*.test.js files found')
  process.exit(1)
}

console.log(`run-tests: ${files.length} file(s) on Node ${process.version}`)
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })

if (result.error !== undefined && result.error !== null) {
  console.error(`run-tests: could not start the test runner: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
