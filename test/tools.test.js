/**
 * Tool-level tests with a fully mocked AgcClient: reports export → trend,
 * review insights, crash summary, the whitelist guard, and digest tools.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'

import { buildRegistry } from '../src/tools/index.js'
import { loadConfig } from '../src/config.js'
import { AuthProvider } from '../src/auth.js'
import { AgcClient } from '../src/client.js'

/** A fake AgcClient: scripted per (method + path-prefix) responses. */
function fakeClient(routes) {
  const calls = []
  return {
    calls,
    async call(method, path, opts = {}) {
      calls.push({ method, path, opts })
      for (const route of routes) {
        if (route.match.test(`${method} ${path}`)) {
          if (route.throw !== undefined) throw route.throw
          return { status: 200, data: typeof route.data === 'function' ? route.data(opts) : route.data, mode: 'api_client' }
        }
      }
      throw new Error(`fakeClient: no route for ${method} ${path}`)
    },
    async download(fileUrl) {
      calls.push({ method: 'DOWNLOAD', path: fileUrl })
      const csv = routes.find(r => r.csv !== undefined)?.csv ?? '日期,下载量\n2026-01-01,10\n'
      return { bytes: Buffer.from('\uFEFF' + csv, 'utf8'), contentType: 'text/csv' }
    },
  }
}

function registryWith(client) {
  const config = loadConfig({ AGC_CLIENT_ID: 'id', AGC_CLIENT_SECRET: 'secret' })
  return buildRegistry({ config, auth: new AuthProvider(config), client })
}

const REPORT_EXPORT_ROUTE = {
  match: /^GET .*appDownloadAnalysisExport/,
  data: { fileURL: 'https://connect-api.cloud.huawei.com/file.csv' },
  csv: '日期,下载量,国家\n2026-01-01,100,CN\n2026-01-02,120,CN\n2026-01-03,90,CN\n',
}

// ── reports ──────────────────────────────────────────────────────────────────

test('agc_report_export exports, downloads and parses rows', async () => {
  const client = fakeClient([REPORT_EXPORT_ROUTE])
  const registry = registryWith(client)
  const res = await registry.get('agc_report_export').run({ appId: 'app1', report: 'harmony-download', startDate: '2026-01-01', endDate: '2026-01-03' })
  assert.equal(res.rowCount, 3)
  assert.equal(res.rows[0]['下载量'], '100')
  assert.equal(res.truncated, false)
  assert.equal(res.header[0], '日期')
  const exportCall = client.calls.find(c => c.path.includes('appDownloadAnalysisExport'))
  assert.equal(exportCall.opts.query.startTime, '20260101')
  assert.equal(exportCall.opts.query.exportType, 'CSV')
})

test('agc_report_export saves raw CSV to outPath with overwrite guard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agc-out-'))
  try {
    const out = join(dir, 'report.csv')
    const client = fakeClient([REPORT_EXPORT_ROUTE])
    const registry = registryWith(client)
    const res = await registry.get('agc_report_export').run({ appId: 'a', report: 'harmony-download', startDate: '2026-01-01', endDate: '2026-01-02', outPath: out })
    assert.equal(res.savedTo, out)
    assert.ok(readFileSync(out, 'utf8').includes('下载量'))
    await assert.rejects(
      () => registry.get('agc_report_export').run({ appId: 'a', report: 'harmony-download', startDate: '2026-01-01', endDate: '2026-01-02', outPath: out }),
      /overwrite/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('agc_report_export refuses ranges over 180 days', async () => {
  const registry = registryWith(fakeClient([]))
  await assert.rejects(
    async () => registry.get('agc_report_export').parse({ appId: 'a', report: 'download', startDate: '2026-01-01', endDate: '2026-12-31' }),
    /180/,
  )
})

test('agc_report_trend returns overview with empty metric and trend with a metric', async () => {
  const client = fakeClient([REPORT_EXPORT_ROUTE])
  const registry = registryWith(client)
  const overview = await registry.get('agc_report_trend').run({ appId: 'a', report: 'harmony-download', metric: '', startDate: '2026-01-01', endDate: '2026-01-03' })
  assert.equal(overview.overview.metrics[0].metric, '下载量')
  const trend = await registry.get('agc_report_trend').run({ appId: 'a', report: 'harmony-download', metric: '下载', startDate: '2026-01-01', endDate: '2026-01-03' })
  assert.equal(trend.trend.daysCovered, 3)
  assert.equal(trend.trend.lastValue, 90)
})

// ── crash ────────────────────────────────────────────────────────────────────

const CRASH_ROUTE = {
  match: /^POST .*crash\/metric/,
  data: { value: { list: [
    { date: '2026-01-01', count: 4, users: 3 },
    { date: '2026-01-02', count: 6, users: 5 },
  ] } },
}

test('agc_crash_metric normalises rows and agc_crash_summary summarises', async () => {
  const client = fakeClient([CRASH_ROUTE])
  const registry = registryWith(client)
  const rows = await registry.get('agc_crash_metric').run({ appId: 'a', startDate: '2026-01-01', endDate: '2026-01-02' })
  assert.deepEqual(rows.rows.map(r => r.count), [4, 6])
  const summary = await registry.get('agc_crash_summary').run({ appId: 'a', startDate: '2026-01-01', endDate: '2026-01-02' })
  assert.equal(summary.total, 10)
  const call = client.calls.find(c => c.path.includes('/api/apm/'))
  assert.equal(call.opts.body.appId, 'a')
})

test('agc_crash_metric passes through unknown response shapes', async () => {
  const client = fakeClient([{ match: /^POST .*crash\/metric/, data: { unexpected: 1 } }])
  const registry = registryWith(client)
  const res = await registry.get('agc_crash_metric').run({ appId: 'a' })
  assert.ok(res.note.includes('unrecognised'))
  assert.deepEqual(res.raw, { unexpected: 1 })
})

// ── reviews ──────────────────────────────────────────────────────────────────

test('agc_ratings_summary calls the marketing API with api_client preference', async () => {
  const client = fakeClient([{ match: /^GET .*ratings/, data: { average: 4.2 } }])
  const registry = registryWith(client)
  const res = await registry.get('agc_ratings_summary').run({ appId: 'a', platform: 'harmonyos', begin: '2026-01-01', end: '2026-02-01' })
  assert.equal(res.average, 4.2)
  const call = client.calls[0]
  assert.equal(call.opts.preferred[0], 'api_client')
  assert.equal(call.opts.query.beginTime, Date.parse('2026-01-01T00:00:00Z'))
})

test('agc_reviews_list rejects windows over six months', async () => {
  const registry = registryWith(fakeClient([]))
  await assert.rejects(
    async () => registry.get('agc_reviews_list').run({ appId: 'a', platform: 'android', begin: '2025-01-01', end: '2025-12-01' }),
    /183/,
  )
})

test('agc_review_insights paginates and clusters', async () => {
  const reviews = []
  for (let i = 0; i < 100; i++) reviews.push({ content: `闪退 issue number ${i}`, rating: 1, appVersion: '1.0' })
  const client = fakeClient([
    {
      match: /^GET .*reviews$/,
      // Page 1 is full (100) so the tool must ask for page 2; page 2 is short.
      data: opts => ({ reviews: opts.query.page === 1 ? reviews : reviews.slice(0, 20) }),
    },
  ])
  const registry = registryWith(client)
  const res = await registry.get('agc_review_insights').run({ appId: 'a', platform: 'harmonyos', begin: '2026-01-01', end: '2026-01-31', pages: 3 })
  assert.equal(res.analysed, 120, 'paginates until a short page')
  assert.ok(res.topTerms.some(t => t.term.includes('闪退')))
})

// ── request whitelist ────────────────────────────────────────────────────────

test('agc_request allows whitelisted reads and refuses everything else', async () => {
  const client = fakeClient([{ match: /^GET .*report\//, data: { ok: 1 } }])
  const registry = registryWith(client)
  const ok = await registry.get('agc_request').run({ path: '/api/report/harmony-report/v1/harmony/voc-report/app1' })
  assert.equal(ok.data.ok, 1)
  assert.equal(client.calls[0].method, 'GET', 'method defaults to GET')

  await assert.rejects(async () => registry.get('agc_request').parse({ path: '/api/publish/v2/app-info', method: 'PUT' }), /must be one of: GET, POST/)
  await assert.rejects(async () => registry.get('agc_request').parse({ path: '/api/marketing-api/v2/reviews/manage/dev/reviews', method: 'POST' }), /GET only/)
  await assert.rejects(async () => registry.get('agc_request').parse({ path: '/api/publish/v2/upload-url/for-obs' }), /whitelist/)
  await assert.rejects(async () => registry.get('agc_request').parse({ path: 'not-an-api-path' }), /must begin with \/api\//)
  // An absolute URL cannot steer the request off the AGC host: only its
  // pathname is kept, and the URL is always rebuilt from the site table.
  const normalized = registry.get('agc_request').parse({ path: 'https://evil.example.com/api/report/x' })
  assert.equal(normalized.path, '/api/report/x')
  await assert.rejects(async () => registry.get('agc_request').parse({ path: 'https://evil.example.com/other/x' }), /must begin with \/api\//)
})

test('agc_request refuses write paths even when run() is called directly', async () => {
  const client = fakeClient([])
  const registry = registryWith(client)
  const tool = registry.get('agc_request')
  const before = client.calls.length
  await assert.rejects(async () => tool.run({ path: '/api/marketing-api/v2/reviews/manage/dev/reviews', method: 'POST', body: {} }), /GET only/)
  await assert.rejects(async () => tool.run({ path: '/api/publish/v2/upload-url/for-obs' }), /whitelist/)
  assert.equal(client.calls.length, before, 'guard runs before any network call')
})

// ── digests ──────────────────────────────────────────────────────────────────

test('agc_daily_report renders markdown with real analytics per section', async () => {
  const client = fakeClient([
    REPORT_EXPORT_ROUTE,
    { match: /^POST .*crash\/metric/, data: { value: { list: [{ date: '2026-01-15', count: 2 }, { date: '2026-01-16', count: 5 }] } } },
    { match: /^GET .*reviews$/, data: { reviews: [{ content: '闪退', rating: 1, appVersion: '1.0' }, { content: '闪退 又闪退', rating: 1, appVersion: '1.0' }, { content: '闪退 三次', rating: 2, appVersion: '1.1' }, { content: '很好用', rating: 5, appVersion: '1.1' }] } },
  ])
  const registry = registryWith(client)
  const res = await registry.get('agc_daily_report').run({ appId: 'a', date: '2026-01-15' })
  assert.match(res.markdown, /# AGC Daily Report — 20260115/)
  // Trend section carries the metrics the analytics layer computed.
  assert.match(res.markdown, /Download & install trend/)
  assert.match(res.markdown, /- 下载量: 310 over the last 7 days/)
  assert.match(res.markdown, /direction/)
  // Crash section summarises rather than dumping raw JSON.
  assert.match(res.markdown, /- crash events: 7 over 2 day\(s\)/)
  // Review section aggregates stars and keywords.
  assert.match(res.markdown, /average rating: 2\.25/)
  assert.match(res.markdown, /top keywords: .*闪退/)
})

test('agc_weekly_report compares the previous week and saves to outPath', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agc-week-'))
  try {
    const out = join(dir, 'weekly.md')
    const requests = []
    const client = fakeClient([
      REPORT_EXPORT_ROUTE,
      {
        match: /^POST .*crash\/metric/,
        data: { value: { list: [
          { date: '2026-01-12', version: '1.0', count: 7 },
          { date: '2026-01-13', version: '1.1', count: 3 },
        ] } },
      },
      { match: /^GET .*reviews$/, data: { reviews: [] } },
    ])
    const originalCall = client.call.bind(client)
    client.call = async (method, path, opts) => { requests.push({ method, path, start: opts?.query?.startTime }); return originalCall(method, path, opts) }
    const registry = registryWith(client)
    const res = await registry.get('agc_weekly_report').run({ appId: 'a', endDate: '2026-01-18', outPath: out })
    assert.match(res.markdown, /# AGC Weekly Report — week ending 20260118/)
    assert.match(res.markdown, /\| last 7 days total \| 310 \|/)
    assert.match(res.markdown, /top versions: 1\.0/)
    assert.ok(existsSync(out))
    assert.equal(res.savedTo, out)
    // The previous week was actually requested (2026-01-05 → 2026-01-11).
    const windows = requests.filter(r => r.path.includes('appDownloadAnalysisExport')).map(r => r.start)
    assert.ok(windows.includes('20260112'), `current week requested: ${windows.join(',')}`)
    assert.ok(windows.includes('20260105'), `previous week requested: ${windows.join(',')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── system ───────────────────────────────────────────────────────────────────

test('agc_auth_status reports configuration without network', async () => {
  const registry = registryWith(fakeClient([]))
  const res = await registry.get('agc_auth_status').run({})
  assert.equal(res.credentialsLoaded.apiClient, true)
  assert.equal(res.credentialsLoaded.serviceAccount, false)
  assert.ok(res.hints[0].includes('Service Account') || res.hints[0].includes('API'))
})

test('registry exposes all 13 tools with unique names', () => {
  const registry = registryWith(fakeClient([]))
  const names = registry.list().map(t => t.name)
  assert.equal(names.length, 13)
  assert.equal(new Set(names).size, 13)
  for (const tool of registry.list()) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.ok(typeof tool.description === 'string' && tool.description.length > 20, `${tool.name} needs a description`)
    assert.ok(typeof tool.parse === 'function' && typeof tool.run === 'function')
  }
})
