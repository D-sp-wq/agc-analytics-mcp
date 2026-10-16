/** Syntax-check every source file and smoke-test the tool registry. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, acc)
    else if (name.endsWith('.js')) acc.push(full)
  }
  return acc
}

test('every source file parses and imports cleanly', async () => {
  const files = walk(join(ROOT, 'src')).concat(join(ROOT, 'index.js'))
  assert.ok(files.length >= 15, `expected a real codebase, found ${files.length} files`)
  for (const file of files) {
    await import(pathToFileURL(file).href)
  }
})

test('zero runtime dependencies', async () => {
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies, undefined, 'no runtime deps allowed')
  assert.equal(pkg.devDependencies, undefined, 'no dev deps allowed')
  // No file may import anything outside node: builtins or relative paths.
  for (const file of walk(join(ROOT, 'src'))) {
    const text = await (await import('node:fs/promises')).readFile(file, 'utf8')
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1]
      assert.ok(spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('../'), `${file} imports "${spec}"`)
    }
  }
})
