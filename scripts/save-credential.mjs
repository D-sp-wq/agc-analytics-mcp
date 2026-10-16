#!/usr/bin/env node
/**
 * Write an AGC credential file without ever echoing the secret.
 *
 *   node scripts/save-credential.mjs                     # interactive (secret hidden)
 *   node scripts/save-credential.mjs --from-text paste.txt   # paste straight from the console
 *   Get-Clipboard | node scripts/save-credential.mjs --from-text -
 *   node scripts/save-credential.mjs --sa ~/Downloads/xxx-private.json
 *   AGC_CLIENT_ID=… AGC_CLIENT_SECRET=… node scripts/save-credential.mjs   # non-interactive
 *   node scripts/save-credential.mjs --check             # show what is configured, no writes
 *
 * Why this exists: the AGC console shows the client secret once, and the usual
 * ways of getting it onto disk (paste into a shell command, paste into a chat,
 * echo into a file) all leak it into a history or a transcript. Here it is read
 * from a hidden prompt — or, with --from-text, straight from whatever the
 * console gave you — and written to a 0600 file. No hand-written JSON.
 *
 * Options:
 *   --from-text <file|->  recognise and store whatever was pasted
 *   --detect <file|->     recognise and report only (writes nothing)
 *   --out <path|dir>      where to write (default ~/.agc)
 *   --sa <path>           validate and relocate a downloaded Service Account JSON
 *   --force               overwrite an existing file
 *   --check               report the current configuration and exit (no writes)
 *   --json                machine-readable result (used by the paste window)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import readline from 'node:readline'
import { detectCredential, documentFor, targetFileFor } from '../src/credential-detect.js'

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const valueOf = name => {
  const index = argv.indexOf(name)
  return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : undefined
}

const expandHome = p => String(p).replace(/^~(?=[\\/])/, homedir())
const defaultOut = join(homedir(), '.agc', 'api-client.json')

const readJson = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

const fingerprint = secret => {
  const s = String(secret)
  return s.length <= 8 ? '****' : `…${s.slice(-4)}`
}

/**
 * Ask one question on a terminal; `hidden` suppresses the echo so the secret
 * never reaches a log, a scrollback or a transcript.
 */
function askHidden(rl, question, hidden) {
  return new Promise(resolveAnswer => {
    if (!hidden) {
      rl.question(question, answer => resolveAnswer(answer.trim()))
      return
    }
    const originalWrite = rl._writeToOutput
    rl._writeToOutput = function suppress(string) {
      if (typeof string === 'string' && string.includes(question)) originalWrite.call(rl, string)
    }
    rl.question(question, answer => {
      rl._writeToOutput = originalWrite
      process.stdout.write('\n')
      resolveAnswer(answer.trim())
    })
  })
}

/**
 * Read everything from a non-TTY stdin and split it into lines.
 *
 * Input may already have arrived — and the stream may have ended — before these
 * listeners attach, so buffered bytes are drained with read() as well;
 * resolving on `readableEnded` alone returned an empty string.
 */
function readPipedLines() {
  return new Promise(resolve => {
    let data = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(data.split(/\r?\n/).map(line => line.trim()))
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', finish)
    let buffered
    while ((buffered = process.stdin.read()) !== null) data += buffered
    if (process.stdin.readableEnded === true) finish()
    process.stdin.resume()
  })
}

/**
 * Collect one answer per label.
 *
 * A terminal is prompted interactively (secret hidden). A pipe or a redirected
 * file is drained first and consumed line by line — calling `rl.question` on an
 * already-ended stream never invokes its callback, which would leave the
 * top-level await unsettled and exit the process with code 13.
 *
 * @param {Array<{label: string, hidden?: boolean}>} questions
 * @returns {Promise<string[]>}
 */
async function collectAnswers(questions) {
  if (process.stdin.isTTY === true) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    try {
      const answers = []
      for (const question of questions) answers.push(await askHidden(rl, question.label, question.hidden === true))
      return answers
    } finally {
      rl.close()
    }
  }
  const lines = await readPipedLines()
  return questions.map((_, index) => lines[index] ?? '')
}

function writeSecure(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, contents, { mode: 0o600 })
  try {
    chmodSync(path, 0o600) // no-op on Windows, meaningful on POSIX
  } catch { /* best effort */ }
}

// ── paste handling: no hand-written JSON ─────────────────────────────────────

const textSource = valueOf('--from-text') ?? (flag('--detect') ? valueOf('--detect') : undefined)

if (textSource !== undefined) {
  const emit = (payload, code) => {
    if (flag('--json')) console.log(JSON.stringify(payload, null, 2))
    else if (payload.message !== undefined) console.log(payload.message)
    else if (payload.problems !== undefined) console.log(payload.problems.join('\n'))
    process.exit(code)
  }

  let text
  try {
    text = textSource === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(expandHome(textSource)), 'utf8')
  } catch (error) {
    emit({ ok: false, problems: [`读取失败：${error.message}`] }, 2)
  }

  const detected = detectCredential(text)
  if (detected.kind === null) {
    emit({
      ok: false,
      kind: null,
      notes: detected.notes,
      problems: detected.problems,
      message: [
        '认不出这段内容：',
        ...detected.problems.map(problem => `  · ${problem}`),
        '',
        '下面任意一种，整段粘进来就行：',
        '  · 控制台给出的 JSON（含 client_id / client_secret）',
        '  · 两行：client_id: … 与 client_secret: …',
        '  · Service Account 的 *private.json 全文',
      ].join('\n'),
    }, 2)
  }

  const targetDir = valueOf('--out') !== undefined ? resolve(expandHome(valueOf('--out'))) : join(homedir(), '.agc')
  const target = join(targetDir, targetFileFor(detected.kind))
  const document = documentFor(detected)
  const label = detected.kind === 'api-client' ? 'API 客户端凭据' : 'Service Account 私钥文件'

  if (flag('--detect')) {
    emit({
      ok: true,
      kind: detected.kind,
      target,
      notes: detected.notes,
      message: `识别成功：${label}\n将保存到：${target}`,
    }, 0)
  }

  if (existsSync(target) && !flag('--force')) {
    emit({ ok: false, target, problems: [`${target} 已存在`], message: `! ${target} 已存在，未覆盖（要覆盖请加 --force）` }, 2)
  }

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  try { chmodSync(target, 0o600) } catch { /* no-op on Windows */ }

  const envName = detected.kind === 'api-client' ? 'AGC_CLIENT_FILE' : 'AGC_SERVICE_ACCOUNT_FILE'
  emit({
    ok: true,
    kind: detected.kind,
    target,
    env: { [envName]: target },
    notes: detected.notes,
    message: [
      `✔ 已保存：${target}`,
      `  识别为：${label}${detected.notes.length !== 0 ? ` — ${detected.notes.join('；')}` : ''}`,
      '',
      '下一步（不联网，只检查文件与字段）：',
      `  ${envName}="${target}" node scripts/live-smoke.mjs --check-only`,
    ].join('\n'),
  }, 0)
}

// ── --check ──────────────────────────────────────────────────────────────────

if (flag('--check')) {
  const lines = []
  const clientPath = process.env.AGC_CLIENT_FILE ?? ''
  const saPath = process.env.AGC_SERVICE_ACCOUNT_FILE ?? ''
  lines.push(`AGC_CLIENT_FILE           : ${clientPath === '' ? '(unset)' : clientPath}`)
  if (clientPath !== '') {
    const body = existsSync(clientPath) ? readJson(clientPath) : undefined
    lines.push(body === undefined
      ? '  ✘ not readable / not valid JSON'
      : `  ${typeof (body.client_id ?? body.clientId) === 'string' ? '✔' : '✘'} client_id present, client_secret ${typeof (body.client_secret ?? body.clientSecret) === 'string' ? 'present' : 'MISSING'}`)
  }
  lines.push(`AGC_SERVICE_ACCOUNT_FILE  : ${saPath === '' ? '(unset)' : saPath}`)
  if (saPath !== '') {
    const body = existsSync(saPath) ? readJson(saPath) : undefined
    lines.push(body === undefined
      ? '  ✘ not readable / not valid JSON'
      : `  ${typeof body.key_id === 'string' && typeof body.private_key === 'string' && typeof body.sub_account === 'string' ? '✔' : '✘'} key_id / private_key / sub_account`)
  }
  lines.push(`AGC_SITE                  : ${process.env.AGC_SITE ?? 'cn (default)'}`)
  console.log(lines.join('\n'))
  process.exit(0)
}

// ── Service Account relocation ───────────────────────────────────────────────

if (valueOf('--sa') !== undefined) {
  const source = resolve(expandHome(valueOf('--sa')))
  if (!existsSync(source)) {
    console.error(`✘ file not found: ${source}`)
    process.exit(2)
  }
  const body = readJson(source)
  if (body === undefined) {
    console.error(`✘ not valid JSON: ${source}`)
    process.exit(2)
  }
  if (typeof body.key_id !== 'string' || typeof body.private_key !== 'string' || typeof body.sub_account !== 'string') {
    console.error('✘ this is not a Service Account JSON (needs key_id, private_key, sub_account)')
    if (typeof body.client_id === 'string') console.error('  it looks like an API-client file — use the interactive mode instead')
    process.exit(2)
  }
  const out = valueOf('--out') !== undefined ? resolve(expandHome(valueOf('--out'))) : join(homedir(), '.agc', 'service-account.json')
  if (existsSync(out) && !flag('--force')) {
    console.error(`✘ ${out} already exists; pass --force to replace it`)
    process.exit(2)
  }
  copyFileSync(source, out)
  try { chmodSync(out, 0o600) } catch { /* best effort */ }
  console.log(`✔ Service Account saved to ${out}`)
  console.log(`  sub_account=${body.sub_account}  key_id=${fingerprint(body.key_id)}`)
  console.log('\nUse it with:')
  console.log(`  AGC_SERVICE_ACCOUNT_FILE=${out} node scripts/live-smoke.mjs --check-only`)
  process.exit(0)
}

// ── API client ───────────────────────────────────────────────────────────────

const out = valueOf('--out') !== undefined ? resolve(expandHome(valueOf('--out'))) : defaultOut
if (existsSync(out) && !flag('--force')) {
  console.error(`✘ ${out} already exists; pass --force to replace it (the old file stays untouched otherwise)`)
  process.exit(2)
}

const envValue = name => {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

let clientId = envValue('AGC_CLIENT_ID') ?? ''
let clientSecret = envValue('AGC_CLIENT_SECRET') ?? ''
const interactive = clientId === '' || clientSecret === ''

if (interactive) {
  console.log('Paste the API client values from the AGC console')
  console.log('(AppGallery Connect → 用户与访问 → API 密钥 → Connect API → API 客户端).')
  console.log('The secret is read with echo off and written straight to a 0600 file — it is never printed.\n')
  if (process.stdin.isTTY !== true) console.log('(stdin is not a terminal: reading client_id and the secret as the first two lines)\n')
  const answers = await collectAnswers([
    { label: 'client_id: ' },
    { label: 'client_secret (hidden): ', hidden: true },
  ])
  if (clientId === '') clientId = answers[0]
  if (clientSecret === '') clientSecret = answers[1]
}

if (clientId === '' || clientSecret === '') {
  console.error('✘ both client_id and client_secret are required')
  process.exit(2)
}

writeSecure(out, `${JSON.stringify({ client_id: clientId, client_secret: clientSecret }, null, 2)}\n`)

console.log(`\n✔ saved to ${out}`)
console.log(`  client_id=${fingerprint(clientId)}  client_secret=${fingerprint(clientSecret)} (values not shown in full)`)
console.log('\nNext:')
console.log(`  1) AGC_CLIENT_FILE=${out} node scripts/live-smoke.mjs --check-only`)
console.log(`  2) AGC_CLIENT_FILE=${out} node scripts/live-smoke.mjs`)
console.log('\nKeep this file out of the repository; the plugin reads it into memory only.')
