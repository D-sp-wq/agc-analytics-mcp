#!/usr/bin/env node
/**
 * Pre-commit / CI secret scan.
 *
 * Patterns are assembled from fragments so this file does not match itself.
 * Exits non-zero with a file listing when anything credential-shaped is found.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage'])
const SKIP_FILES = new Set(['check-secrets.mjs', 'package-lock.json'])

const RULES = [
  { name: 'GitHub token', re: new RegExp(`gh${'p_'}[A-Za-z0-9]{20,}|github${'_pat_'}[A-Za-z0-9_]{20,}`) },
  // A PEM *header* is just a template string; a real key has a base64 body after it.
  { name: 'private key material', re: new RegExp(`-----BEGIN [A-Z ]*${'PRIVATE'} KEY-----[\\s\\S]{0,40}?[A-Za-z0-9+/]{60,}`) },
  { name: 'hard-coded client secret', re: new RegExp(`client_?sec${'ret'}["']?\\s*[:=]\\s*["'][A-Za-z0-9+/_\\-]{16,}["']`, 'i') },
  { name: 'hard-coded access token', re: new RegExp(`access_?to${'ken'}["']?\\s*[:=]\\s*["'][A-Za-z0-9._\\-]{16,}["']`, 'i') },
  { name: 'Huawei cloud AK', re: new RegExp(`\\b(AKID|AKLT|AKTP)[A-Za-z0-9]{12,}`) },
  { name: 'OpenAI-style key', re: new RegExp(`sk-[A-Za-z0-9]{24,}`) },
]

/** Files that are allowed to contain credential-like strings (fixtures). */
const ALLOWLIST = [/[/\\]test[/\\]/, /README/, /SECURITY\.md$/]

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, acc)
    else acc.push(full)
  }
  return acc
}

const findings = []
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file)
  if (SKIP_FILES.has(rel.replace(/\\/g, '/'))) continue
  if (ALLOWLIST.some(re => re.test(file))) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  // Binary-ish files are not worth scanning.
  if (text.includes('\u0000')) continue
  for (const rule of RULES) {
    const match = rule.re.exec(text)
    if (match !== null) {
      findings.push({ file: rel, rule: rule.name, sample: `${match[0].slice(0, 12)}…` })
    }
  }
}

if (findings.length !== 0) {
  console.error('Potential secrets found:')
  for (const finding of findings) console.error(`  - ${finding.rule} in ${finding.file} (${finding.sample})`)
  console.error('\nRemove the value, rotate the credential, and re-run. Test fixtures may use obviously fake values under test/.')
  process.exit(1)
}
console.log('check-secrets: clean')
