#!/usr/bin/env node
/**
 * Live smoke test against the real AGC API. Not part of CI — it needs real
 * credentials and hits Huawei's servers (read-only calls only).
 *
 *   node scripts/live-smoke.mjs --check-only                  # offline pre-flight
 *   AGC_CLIENT_FILE=~/.agc/api-client.json node scripts/live-smoke.mjs
 *   AGC_SERVICE_ACCOUNT_FILE=~/.agc/sa.json node scripts/live-smoke.mjs 110012345
 *   node scripts/live-smoke.mjs --days=14 --json
 *
 * Exit codes: 0 = core path works, 1 = a core step failed, 2 = credentials
 * missing or unusable, 3 = bad command line.
 */

import { existsSync, readFileSync } from 'node:fs'
import { loadConfig } from '../src/config.js'
import { AuthProvider } from '../src/auth.js'
import { AgcClient } from '../src/client.js'
import { buildRegistry } from '../src/tools/index.js'
import { safeMessage } from '../src/redact.js'

// ── command line ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node scripts/live-smoke.mjs [appId] [--days=7] [--check-only] [--json]')
  process.exit(0)
}
const flags = new Set(argv.filter(a => a.startsWith('--')))
const positional = argv.filter(a => !a.startsWith('--'))
const daysArg = argv.find(a => a.startsWith('--days='))
const days = daysArg !== undefined ? Number(daysArg.split('=')[1]) : 7
if (!Number.isFinite(days) || days < 1 || days > 180) {
  console.error('--days must be between 1 and 180')
  process.exit(3)
}
const checkOnly = flags.has('--check-only')
const asJson = flags.has('--json')

const readJson = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Validate the credential files before anything touches the network, and name
 * the classic mistakes explicitly — a mis-shaped file is the most common first
 * failure, and the raw config problems are easy to misread.
 */
/** Values that ship in the template files — a file still holding them is not a credential. */
const PLACEHOLDER = /在此粘贴|你的 client|your[_-]?client|YOUR_|xxx+|placeholder|example/i

function preflight(config, env = process.env) {
  const findings = []
  /** Paths already reported as missing, so the config problem is not repeated. */
  const missing = new Set()

  const clientFile = env.AGC_CLIENT_FILE
  if (clientFile !== undefined && clientFile !== '') {
    if (!existsSync(clientFile)) {
      missing.add(clientFile)
      findings.push({ level: 'error', text: `AGC_CLIENT_FILE does not exist: ${clientFile}` })
    } else {
      const body = readJson(clientFile)
      if (body === undefined) findings.push({ level: 'error', text: `AGC_CLIENT_FILE is not valid JSON: ${clientFile}` })
      else if (body.key_id !== undefined || body.private_key !== undefined) {
        findings.push({ level: 'error', text: 'AGC_CLIENT_FILE looks like a Service Account file (key_id/private_key) — point AGC_SERVICE_ACCOUNT_FILE at it instead' })
      } else if (typeof (body.client_id ?? body.clientId) !== 'string' || typeof (body.client_secret ?? body.clientSecret) !== 'string') {
        findings.push({ level: 'error', text: `AGC_CLIENT_FILE needs string fields client_id and client_secret (got: ${Object.keys(body).join(', ') || 'no fields'})` })
      } else if (PLACEHOLDER.test(String(body.client_id ?? body.clientId)) || PLACEHOLDER.test(String(body.client_secret ?? body.clientSecret))) {
        findings.push({ level: 'error', text: `AGC_CLIENT_FILE still holds template/placeholder values: ${clientFile} — copy the real client_id and client_secret in, or run node scripts/save-credential.mjs` })
      } else {
        findings.push({ level: 'ok', text: `AGC_CLIENT_FILE ok (client_id …${String(body.client_id ?? body.clientId).slice(-4)})` })
      }
    }
  }

  const saFile = env.AGC_SERVICE_ACCOUNT_FILE
  if (saFile !== undefined && saFile !== '') {
    if (!existsSync(saFile)) {
      missing.add(saFile)
      findings.push({ level: 'error', text: `AGC_SERVICE_ACCOUNT_FILE does not exist: ${saFile}` })
    } else {
      const body = readJson(saFile)
      if (body === undefined) findings.push({ level: 'error', text: `AGC_SERVICE_ACCOUNT_FILE is not valid JSON: ${saFile}` })
      else if (body.client_id !== undefined && body.key_id === undefined) {
        findings.push({ level: 'error', text: 'AGC_SERVICE_ACCOUNT_FILE looks like an API-client file (client_id/client_secret) — point AGC_CLIENT_FILE at it instead' })
      } else if (typeof body.key_id !== 'string' || typeof body.private_key !== 'string' || typeof body.sub_account !== 'string') {
        findings.push({ level: 'error', text: `AGC_SERVICE_ACCOUNT_FILE needs key_id, private_key and sub_account (got: ${Object.keys(body).join(', ') || 'no fields'})` })
      } else if (PLACEHOLDER.test(String(body.key_id)) || PLACEHOLDER.test(String(body.sub_account))) {
        findings.push({ level: 'error', text: `AGC_SERVICE_ACCOUNT_FILE still holds template/placeholder values: ${saFile} — use the file downloaded from the console` })
      } else {
        findings.push({ level: 'ok', text: `AGC_SERVICE_ACCOUNT_FILE ok (sub_account=${body.sub_account})` })
      }
    }
  }

  const hasEnvClient = typeof env.AGC_CLIENT_ID === 'string' && env.AGC_CLIENT_ID !== ''
    && typeof env.AGC_CLIENT_SECRET === 'string' && env.AGC_CLIENT_SECRET !== ''
  if (config.apiClient === null && config.serviceAccount === null && !hasEnvClient
    && (clientFile === undefined || clientFile === '') && (saFile === undefined || saFile === '')) {
    findings.push({ level: 'error', text: 'no AGC credentials configured' })
  }

  // Config-level problems are noise when the same path was already reported as
  // missing above (ENOENT would show twice for one mistake).
  for (const problem of config.problems) {
    if ([...missing].some(path => problem.includes(path))) continue
    findings.push({ level: 'warn', text: problem })
  }
  return findings
}

// ── run ──────────────────────────────────────────────────────────────────────

const config = loadConfig(process.env)
const auth = new AuthProvider(config)
const client = new AgcClient(config, auth)
const registry = buildRegistry({ config, auth, client })

const steps = []
const record = (name, status, detail = '') => {
  steps.push({ name, status, detail })
  if (!asJson) {
    const mark = status === 'ok' ? '✔' : status === 'warn' ? '!' : '✘'
    console.log(`${mark} ${name}${detail !== '' ? ` — ${detail}` : ''}`)
  }
}

const pre = preflight(config)
if (!asJson) {
  console.log('credential pre-flight:')
  for (const finding of pre) {
    console.log(`  ${finding.level === 'ok' ? '✔' : finding.level === 'warn' ? '!' : '✘'} ${finding.text}`)
  }
  console.log(`\nsite: ${config.site} (${config.baseUrl})${config.baseUrl.includes('127.0.0.1') ? '  [AGC_BASE_URL override — mock upstream]' : ''}`)
  if (!checkOnly) console.log(`window: last ${days} day(s)\n`)
}

const credentialErrors = pre.filter(f => f.level === 'error')
if (credentialErrors.length !== 0) {
  if (asJson) console.log(JSON.stringify({ ok: false, preflight: pre }, null, 2))
  else {
    console.error('\nFix the credential problems above, then re-run.')
    console.error('\nWhere to get them: AppGallery Connect → 用户与访问 → API 密钥 → Connect API')
    console.error('  API client      : create one (project: N/A) → save {"client_id":"...","client_secret":"..."}')
    console.error('  Service account : create a developer-level one → the downloaded *private.json')
    console.error('  Then: AGC_CLIENT_FILE=/abs/path/api-client.json node scripts/live-smoke.mjs')
  }
  process.exit(2)
}

if (checkOnly) {
  if (asJson) console.log(JSON.stringify({ ok: true, preflight: pre, credentials: auth.describe(), site: config.site }, null, 2))
  else console.log('\npre-flight passed — credentials look usable (nothing was sent to Huawei)')
  process.exit(0)
}

/** `YYYYMMDD` for today plus `offset` days (UTC). */
const dayString = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '')
const endDate = dayString(-1)
const startDate = dayString(-days)

let exitCode = 0
try {
  const status = await registry.get('agc_auth_status').run({})
  record('auth status', 'ok', `apiClient=${status.credentialsLoaded.apiClient} serviceAccount=${status.credentialsLoaded.serviceAccount}; site=${status.site}`)

  let appId = positional[0]
  try {
    const apps = await registry.get('agc_list_apps').run({})
    const flat = apps.projects.flatMap(p => (p.apps ?? []).map(a => ({ ...a, project: p.name })))
    record('list apps', 'ok', `${apps.projects.length} project(s), ${flat.length} app(s)`)
    if (!asJson) for (const app of flat.slice(0, 10)) console.log(`    - ${app.appId}  ${app.appName ?? ''}  ${app.packageName ?? ''}`)
    if (appId === undefined && flat.length !== 0) appId = flat[0].appId
  } catch (error) {
    record('list apps', 'fail', safeMessage(error))
    exitCode = 1
  }

  if (appId === undefined) {
    record('report trend', 'fail', 'no appId available — pass one as the first argument')
    exitCode = 1
  } else {
    // HarmonyOS first, then the Android report kind for the same app.
    let reported = false
    for (const report of ['harmony-download', 'download']) {
      try {
        const trend = await registry.get('agc_report_trend').run({ appId, report, metric: '', startDate, endDate })
        const overview = trend.overview
        if (overview?.error !== undefined) {
          record(`report trend (${report})`, 'warn', overview.error)
          continue
        }
        record(`report trend (${report})`, 'ok', `${overview.daysCovered} day(s); metrics: ${overview.metrics.map(m => m.metric).join(', ') || '(none)'}`)
        reported = true
        break
      } catch (error) {
        record(`report trend (${report})`, 'warn', safeMessage(error))
      }
    }
    if (!reported) {
      record('report trend', 'fail', 'neither harmony-download nor download returned data for this app')
      exitCode = 1
    }

    try {
      const crash = await registry.get('agc_crash_summary').run({ appId, startDate, endDate })
      if (crash.raw !== undefined) record('crash summary', 'warn', 'response shape not recognised (beta endpoint)')
      else record('crash summary', 'ok', `total=${crash.total} over ${crash.daysCovered} day(s)`)
    } catch (error) {
      record('crash summary', 'warn', `${safeMessage(error)} (beta endpoint)`)
    }

    try {
      const ratings = await registry.get('agc_ratings_summary').run({ appId, platform: 'harmonyos', begin: startDate, end: endDate })
      record('ratings summary', 'ok', `keys: ${Object.keys(ratings ?? {}).slice(0, 5).join(', ') || '(empty)'}`)
    } catch (error) {
      record('ratings summary', 'warn', `${safeMessage(error)} — the review API needs the API-client credential`)
    }
  }
} catch (error) {
  record('unexpected failure', 'fail', safeMessage(error))
  exitCode = 1
}

const summary = {
  ok: exitCode === 0,
  credentials: auth.describe(),
  site: config.site,
  window: { startDate, endDate, days },
  steps,
}
if (asJson) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  const failed = steps.filter(s => s.status === 'fail')
  const warned = steps.filter(s => s.status === 'warn')
  console.log(`\n${steps.length - failed.length - warned.length} ok, ${warned.length} warning(s), ${failed.length} failure(s)`)
  if (warned.length !== 0) console.log('warnings are sections this credential/site cannot serve — the core path still works')
}
process.exit(exitCode)
