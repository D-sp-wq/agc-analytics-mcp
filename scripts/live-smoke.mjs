#!/usr/bin/env node
/**
 * Live smoke test against the real AGC API. Not part of CI — it needs real
 * credentials and hits Huawei's servers (read-only calls only).
 *
 *   AGC_CLIENT_ID=... AGC_CLIENT_SECRET=... node scripts/live-smoke.mjs [appId]
 *   AGC_SERVICE_ACCOUNT_FILE=... node scripts/live-smoke.mjs
 *
 * It reports, step by step, what worked and what did not, so a first-time
 * setup can be validated in one command.
 */

import { loadConfig } from '../src/config.js'
import { AuthProvider } from '../src/auth.js'
import { AgcClient } from '../src/client.js'
import { buildRegistry } from '../src/tools/index.js'
import { safeMessage } from '../src/redact.js'

const config = loadConfig(process.env)
const auth = new AuthProvider(config)
const client = new AgcClient(config, auth)
const registry = buildRegistry({ config, auth, client })

const explicitAppId = process.argv[2]

function step(name, ok, detail) {
  console.log(`${ok ? '✔' : '✘'} ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
}

async function run() {
  console.log(`credentials: ${auth.describe()}`)
  console.log(`site: ${config.site} (${config.baseUrl})`)
  if (config.problems.length !== 0) {
    for (const problem of config.problems) console.log(`  ! ${problem}`)
  }
  if (auth.modes().length === 0) {
    console.error('\nNo credentials configured. Set AGC_CLIENT_ID/AGC_CLIENT_SECRET or AGC_CLIENT_FILE (and optionally AGC_SERVICE_ACCOUNT_FILE).')
    process.exit(2)
  }

  const status = await registry.get('agc_auth_status').run({})
  step('auth status', true, `apiClient=${status.credentialsLoaded.apiClient} serviceAccount=${status.credentialsLoaded.serviceAccount}`)

  let appId = explicitAppId
  try {
    const apps = await registry.get('agc_list_apps').run({})
    const flat = apps.projects.flatMap(p => (p.apps ?? []).map(a => ({ ...a, project: p.name })))
    step('list apps', true, `${apps.projects.length} project(s), ${flat.length} app(s)`)
    for (const app of flat.slice(0, 10)) console.log(`    - ${app.appId}  ${app.appName ?? ''}  ${app.packageName ?? ''}`)
    if (appId === undefined && flat.length !== 0) appId = flat[0].appId
  } catch (error) {
    step('list apps', false, safeMessage(error))
  }

  if (appId === undefined) {
    console.error('\nNo appId available (pass one as the first argument if listing apps is not permitted).')
    process.exit(2)
  }
  console.log(`\nusing appId ${appId}`)

  try {
    const trend = await registry.get('agc_report_trend').run({ appId, report: 'harmony-download', metric: '' })
    if (trend.overview?.error !== undefined) step('harmony-download report', false, trend.overview.error)
    else step('harmony-download report', true, `${trend.overview.daysCovered} day(s), metrics: ${trend.overview.metrics.map(m => m.metric).join(', ')}`)
  } catch (error) {
    // The Android report usually exists for the same app; try it before failing.
    step('harmony-download report', false, safeMessage(error))
    try {
      const trend = await registry.get('agc_report_trend').run({ appId, report: 'download', metric: '' })
      step('android download report', true, `${trend.overview?.daysCovered ?? 0} day(s)`)
    } catch (second) {
      step('android download report', false, safeMessage(second))
    }
  }

  try {
    const crash = await registry.get('agc_crash_summary').run({ appId })
    step('crash summary', crash.raw === undefined, crash.raw === undefined ? `total=${crash.total}` : 'shape not recognised (beta endpoint)')
  } catch (error) {
    step('crash summary', false, safeMessage(error))
  }

  try {
    const ratings = await registry.get('agc_ratings_summary').run({ appId, platform: 'harmonyos' })
    step('ratings summary', true, typeof ratings === 'object' ? Object.keys(ratings).slice(0, 5).join(', ') : 'ok')
  } catch (error) {
    step('ratings summary', false, `${safeMessage(error)} (the review API needs the API-client credential)`)
  }

  console.log('\nSmoke test finished. Sections marked ✘ above are the only ones your credential/site cannot serve.')
}

run().catch(error => {
  console.error(`smoke test failed: ${safeMessage(error)}`)
  process.exit(1)
})
