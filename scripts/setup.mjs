#!/usr/bin/env node
/**
 * One-command setup for people who have never done this before.
 *
 *   node scripts/setup.mjs
 *
 * It walks the whole path: checks Node, asks which credential you have (or
 * takes it from flags), stores it in ~/.agc with tight permissions, verifies
 * it offline, offers a real read-only smoke test, and finally prints the exact
 * block to paste into your AI client — including the paths for this machine.
 *
 * Non-interactive / scripted:
 *   node scripts/setup.mjs --client-id <id> --client-secret <secret>
 *   node scripts/setup.mjs --sa "C:\Users\me\Downloads\xxx-private.json"
 *   node scripts/setup.mjs --print-config-only
 *   node scripts/setup.mjs --no-smoke --force
 *
 * Nothing is ever sent anywhere here except Huawei's own AGC endpoints, and
 * only if you accept the smoke test.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, copyFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const repo = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const valueOf = name => {
  const index = argv.indexOf(name)
  return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : undefined
}

const credDir = join(homedir(), '.agc')
const clientPath = join(credDir, 'api-client.json')
const saPath = join(credDir, 'service-account.json')
const expand = p => String(p).replace(/^~(?=[\\/])/, homedir()).replace(/^"|"$/g, '').trim()

const say = text => process.stdout.write(`${text}\n`)
const step = text => say(`\n── ${text} ${'─'.repeat(Math.max(0, 58 - text.length))}`)

// ── tiny prompt helpers (terminal interactive, pipe line-by-line) ────────────

function readPipedLines() {
  return new Promise(resolve => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data.split(/\r?\n/).map(l => l.trim())))
    if (process.stdin.readableEnded === true) resolve(data.split(/\r?\n/).map(l => l.trim()))
    process.stdin.resume()
  })
}

function askHidden(rl, question, hidden) {
  return new Promise(resolve => {
    if (!hidden) return rl.question(question, a => resolve(a.trim()))
    const original = rl._writeToOutput
    rl._writeToOutput = function (string) {
      if (typeof string === 'string' && string.includes(question)) original.call(rl, string)
    }
    rl.question(question, a => {
      rl._writeToOutput = original
      process.stdout.write('\n')
      resolve(a.trim())
    })
  })
}

/**
 * Piped input is drained once and then consumed line by line across every
 * question. Draining per question would reset the cursor and hand the following
 * question an empty answer, because the stream has already ended.
 */
let pipedLines = null
let pipedCursor = 0

async function nextPipedLine() {
  if (pipedLines === null) pipedLines = await readPipedLines()
  return pipedLines[pipedCursor++] ?? ''
}

/**
 * Collect answers for `questions` one at a time.
 * A terminal prompts interactively; a pipe is consumed line by line.
 * @param {Array<{label: string, hidden?: boolean}>} questions
 */
async function ask(questions) {
  if (process.stdin.isTTY === true) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    try {
      const answers = []
      for (const q of questions) answers.push(await askHidden(rl, q.label, q.hidden === true))
      return answers
    } finally {
      rl.close()
    }
  }
  const answers = []
  for (let i = 0; i < questions.length; i++) answers.push(await nextPipedLine())
  return answers
}

function writeSecure(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, contents, { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* no-op on Windows */ }
}

const runScript = (script, args, env) => new Promise(resolve => {
  const child = spawn(process.execPath, [join(repo, 'scripts', script), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  child.on('close', code => resolve({ code, out }))
})

// ── what the user sees ───────────────────────────────────────────────────────

say('agc-analytics-mcp 安装向导')
say('这个向导只做四件事：存好凭据 → 本地校验 → （可选）真实只读验证 → 给你一段可粘贴的配置。')
say('全程不会把你的凭据发到任何第三方，最终只会用于访问华为 AGC 官方接口。')

step('1/5 检查运行环境')
const major = Number(process.versions.node.split('.')[0])
say(`Node.js 版本：${process.version}${major >= 20 ? '  ✔' : '  ✘ 需要 20 或更高，请先到 https://nodejs.org 安装 LTS 版本'}`)
if (major < 20) process.exit(2)
say(`凭据目录：${credDir}`)

// ── credential collection ────────────────────────────────────────────────────

/** An env var set to an empty string means "not provided" — ?? alone would take it. */
const envValue = name => {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

let clientId = envValue('AGC_CLIENT_ID') ?? valueOf('--client-id') ?? ''
let clientSecret = envValue('AGC_CLIENT_SECRET') ?? valueOf('--client-secret') ?? ''
let saSource = valueOf('--sa') ?? ''

if (!flag('--print-config-only')) {
  step('2/5 放入凭据')
  const haveClient = clientId !== '' && clientSecret !== ''
  const haveSa = saSource !== ''
  const skipAsking = haveClient || haveSa || flag('--no-input')

  if (skipAsking) {
    if (haveClient) say('已从参数/环境变量得到 API 客户端凭据。')
    if (haveSa) say(`已指定 Service Account 文件：${saSource}`)
  } else {
    say('你需要哪一种？')
    say('  1) API 客户端  —— 推荐。13 个工具全支持（含评论/评分）')
    say('  2) Service Account 文件 —— 控制台会下载一个 *private.json')
    say('  3) 两个都有')
    const [choiceRaw] = await ask([{ label: '请输入 1 / 2 / 3（默认 1）：' }])
    const choice = choiceRaw === '' ? '1' : choiceRaw

    if (choice === '1' || choice === '3') {
      say('')
      say('┌─ 在哪个页面创建？───────────────────────────────────────────')
      say('│ 请打开 AppGallery Connect（AGC）控制台，不是 HarmonyOS 开发者中心：')
      say('│   https://developer.huawei.com/consumer/cn/service/josp/agc/index.html')
      say('│ 路径：左侧「用户与访问 → API 密钥 → Connect API → API 客户端 → 创建」')
      say('│ 注意：「项目」选 N/A（否则部分接口会没权限）')
      say('│')
      say('│ 找不到「API 密钥」入口？多半是打开成了 HarmonyOS 开发者中心')
      say('│ （网址含 hdc-console，左侧「用户与访问」下只有开发者信息/团队账号/')
      say('│  关联主体/沙盒测试账号等，没有 API 密钥）。对照排查：')
      say('│   docs/WHERE-IS-API-KEY.md')
      say('└─────────────────────────────────────────────────────────────')
      const [id, secret] = await ask([
        { label: 'client_id: ' },
        { label: 'client_secret（输入时不显示）: ', hidden: true },
      ])
      clientId = id
      clientSecret = secret
    }
    if (choice === '2' || choice === '3') {
      say('')
      say('┌─ 服务帐号密钥文件从哪来？─────────────────────────────────')
      say('│ 开发者联盟 API Console：')
      say('│   https://developer.huawei.com/consumer/cn/console/api/credentials')
      say('│ 路径：API服务 → 配置 → 选择项目 → 创建服务帐号密钥文件')
      say('│      → 生成公私钥 → 创建并下载 JSON')
      say('│ （AGC 里也有：用户与访问 → API 密钥 → Service Account → 创建，')
      say('│   类型选开发者级，同样会自动下载 *private.json）')
      say('└─────────────────────────────────────────────────────────────')
      say('把下载到的 *private.json 直接拖到这里（或粘贴完整路径），然后回车：')
      const [file] = await ask([{ label: '文件路径: ' }])
      saSource = file
    }
  }

  if (clientId !== '' || clientSecret !== '') {
    if (clientId === '' || clientSecret === '') {
      say('\n✘ client_id 和 client_secret 必须都有，请重新运行向导。')
      process.exit(2)
    }
    if (existsSync(clientPath) && !flag('--force')) {
      say(`\n! 已存在 ${clientPath}，保留原文件（要覆盖请加 --force）`)
    } else {
      writeSecure(clientPath, `${JSON.stringify({ client_id: clientId, client_secret: clientSecret }, null, 2)}\n`)
      say(`✔ 已保存：${clientPath}（权限已收紧，仅你可读）`)
    }
  }

  if (saSource !== '') {
    const source = resolve(expand(saSource))
    if (!existsSync(source)) {
      say(`\n✘ 找不到文件：${source}`)
      process.exit(2)
    }
    let body
    try { body = JSON.parse(readFileSync(source, 'utf8')) } catch { body = undefined }
    if (body === undefined || typeof body.key_id !== 'string' || typeof body.private_key !== 'string' || typeof body.sub_account !== 'string') {
      say('\n✘ 这个文件不是 Service Account 的 *private.json（需要 key_id / private_key / sub_account 三个字段）')
      say('  如果你手里是 client_id + client_secret，请选 1) API 客户端。')
      process.exit(2)
    }
    if (existsSync(saPath) && !flag('--force')) say(`! 已存在 ${saPath}，保留原文件`)
    else {
      copyFileSync(source, saPath)
      try { chmodSync(saPath, 0o600) } catch { /* best effort */ }
      say(`✔ 已保存：${saPath}`)
    }
  }
}

// ── the env block every client config needs ──────────────────────────────────

const envEntries = []
if (existsSync(clientPath)) envEntries.push(['AGC_CLIENT_FILE', clientPath])
if (existsSync(saPath)) envEntries.push(['AGC_SERVICE_ACCOUNT_FILE', saPath])
const site = envValue('AGC_SITE') ?? 'cn'
envEntries.push(['AGC_SITE', site])
const entryPath = join(repo, 'index.js').replace(/\\/g, '/')

const configJson = JSON.stringify({
  mcpServers: {
    agc: {
      command: 'node',
      args: [entryPath],
      env: Object.fromEntries(envEntries),
    },
  },
}, null, 2)

step('3/5 本地校验（不联网）')
if (envEntries.every(([key]) => key === 'AGC_SITE')) {
  say('没有检测到任何凭据文件或环境变量。')
  say('最快的方式：不用文件，直接把两个值写进你的 AI 客户端配置里（见下一步的“方式 B”）。')
} else if (!flag('--print-config-only')) {
  const env = Object.fromEntries(envEntries)
  const result = await runScript('live-smoke.mjs', ['--check-only'], env)
  say(result.out.trim())
  if (result.code !== 0) {
    say('\n向导已把凭据放好，但校验没通过 —— 按上面的提示修正后重新运行一次即可。')
    process.exit(2)
  }
} else {
  say('（--print-config-only：跳过校验）')
}

// ── optional live smoke ──────────────────────────────────────────────────────

if (!flag('--no-smoke') && !flag('--print-config-only')) {
  step('4/5 真实只读验证（可选）')
  say('会用你的凭据访问华为 AGC 官方接口，只做读取：项目列表、最近 7 天报表、崩溃指标、评分。')
  let yes = flag('--smoke')
  if (!yes) {
    if (process.stdin.isTTY === true) {
      const [answer] = await ask([{ label: '现在验证吗？(Y/n) ' }])
      yes = answer === '' || /^y(es)?$/i.test(answer)
    } else {
      // Never make an outbound call by default when nobody is there to answer.
      yes = false
      say('非交互环境：默认跳过真实调用（要跑请加 --smoke）')
    }
  }
  if (yes) {
    const env = Object.fromEntries(envEntries)
    const result = await runScript('live-smoke.mjs', ['--json'], env)
    try {
      const payload = JSON.parse(result.out.slice(result.out.indexOf('{')))
      for (const s of payload.steps ?? []) {
        say(`  ${s.status === 'ok' ? '✔' : s.status === 'warn' ? '!' : '✘'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`)
      }
      say(result.code === 0 ? '\n核心链路可用 ✔' : '\n有核心步骤失败，请把上面的输出发给维护者')
    } catch {
      say(result.out.trim())
    }
  } else {
    say('已跳过。想验证时随时运行：node scripts/live-smoke.mjs')
  }
} else {
  step('4/5 真实只读验证')
  say('已跳过（--no-smoke / --print-config-only）')
}

// ── paste-ready configuration ────────────────────────────────────────────────

step('5/5 把下面这段粘进你的 AI 客户端')
say('Claude Desktop / Cursor / VS Code / Trae 等的 MCP 配置文件里，找到 "mcpServers" 这一层，')
say('把 "agc" 这一段放进去（各客户端的具体文件位置见 README）。\n')
say(configJson)
say('\n──────────────────────────────────────────────')
say('方式 B：不想用文件？把两个值直接写进 env，省掉上面的文件步骤：\n')
say(JSON.stringify({
  mcpServers: {
    agc: {
      command: 'node',
      args: [entryPath],
      env: { AGC_CLIENT_ID: '<client_id>', AGC_CLIENT_SECRET: '<client_secret>', AGC_SITE: site },
    },
  },
}, null, 2))
say('\n注意：方式 B 会把密钥写在客户端配置里（本机文件），换来的是“不用终端、不用管路径”。')
say('两种方式互不影响，用哪个都行。')

say('\n──────────────────────────────────────────────')
say('之后可以这样用（在 AI 客户端里直接说）：')
say('  · “先跑 agc_auth_status 看看配置对不对”')
say('  · “列出我的 AGC 应用”')
say('  · “最近 30 天下载量趋势如何？有异常日吗？”')
say('  · “出一份昨天的日报”')
say(`\n更多：${join(repo, 'README.md')}`)
say(`凭据说明：${join(credDir, 'README-凭据放这里.txt')}`)
