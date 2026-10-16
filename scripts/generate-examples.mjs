#!/usr/bin/env node
/**
 * Generate the committed example outputs in `docs/examples/`.
 *
 * Runs the real tools against a local mock AGC upstream (no credentials, no
 * network), so the examples are reproducible and always match the current
 * code: `node scripts/generate-examples.mjs`.
 *
 * The mock speaks the same shapes as the real service (token endpoint, report
 * export + signed CSV, APM crash metric, review list) so what lands in the
 * examples is exactly what a tool call returns.
 */

import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../src/config.js'
import { AuthProvider } from '../src/auth.js'
import { AgcClient } from '../src/client.js'
import { buildRegistry } from '../src/tools/index.js'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const outDir = join(root, 'docs', 'examples')
mkdirSync(outDir, { recursive: true })

// ── sample data ──────────────────────────────────────────────────────────────

/** 30 days of downloads with a launch bump and one anomaly day. */
function sampleDownloadCsv() {
  const lines = ['日期,下载量,安装量,卸载量']
  const start = Date.UTC(2026, 4, 1) // 2026-05-01
  for (let i = 0; i < 30; i++) {
    const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10)
    const base = 320 + Math.round(Math.sin(i / 3) * 40)
    const launch = i === 12 ? 1_450 : 0 // release day spike
    const downloads = base + launch + (i % 7 === 0 ? -60 : 0)
    const installs = Math.round(downloads * 0.82)
    const uninstalls = 40 + (i % 5) * 7
    lines.push(`${day},${downloads},${installs},${uninstalls}`)
  }
  return `${lines.join('\n')}\n`
}

/** Crash metrics: two versions over two weeks, one bad day. */
function sampleCrashPayload() {
  const rows = []
  const start = Date.UTC(2026, 4, 17) // 2026-05-17 … 2026-05-30
  for (let i = 0; i < 14; i++) {
    const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10)
    const releaseEffect = i >= 7 ? 1.7 : 1 // 2.3.0 ships in the second week
    rows.push({ date: day, appVersion: '2.3.0', count: Math.round((16 + i) * releaseEffect), users: 12 + i })
    rows.push({ date: day, appVersion: '2.2.1', count: 9 - Math.floor(i / 3), users: 6 })
  }
  // One genuinely bad day for 2.3.0.
  rows.push({ date: '2026-05-27', appVersion: '2.3.0', count: 96, users: 61 })
  return { value: { list: rows } }
}

/** Reviews: a handful of realistic complaints and praise. */
function sampleReviews() {
  const texts = [
    ['更新后一直闪退，打开就闪退，根本用不了', 1, '2.3.0'],
    ['闪退严重，登录都登录不了，麻烦尽快修复', 1, '2.3.0'],
    ['登录失败提示验证码错误，但验证码是对的', 2, '2.3.0'],
    ['升级到 2.3.0 之后卡顿明显，滑动掉帧', 2, '2.3.0'],
    ['同步数据太慢了，等了两分钟还没好', 3, '2.3.0'],
    ['闪退问题终于修复了，好用', 5, '2.2.1'],
    ['界面清爽，提醒很准时，点赞', 5, '2.2.1'],
    ['希望增加家庭成员共享功能', 4, '2.2.1'],
    ['字体有点小，老人看不清', 3, '2.2.1'],
    ['客服回复很快，问题解决了', 5, '2.3.0'],
  ]
  return {
    value: {
      list: texts.map(([content, rating, appVersion], index) => ({
        reviewId: String(10_000 + index),
        content,
        rating,
        appVersion,
        reviewTime: `2026-05-2${5 + (index % 3)} 10:${String(10 + index).padStart(2, '0')}:00`,
      })),
    },
  }
}

// ── mock upstream ────────────────────────────────────────────────────────────

const csv = sampleDownloadCsv()
const server = createServer((req, res) => {
  const json = (body, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.url === '/api/oauth2/v1/token') return json({ access_token: 'example-token', expires_in: 3600 })
  if (req.url.startsWith('/api/report/')) {
    if (req.headers.authorization !== 'Bearer example-token') return json({ ret: { code: 401, msg: 'unauthorized' } }, 401)
    return json({ ret: { code: 0 }, fileURL: `http://127.0.0.1:${server.address().port}/download.csv` })
  }
  if (req.url === '/download.csv') {
    res.writeHead(200, { 'content-type': 'text/csv' })
    return res.end(`\uFEFF${csv}`)
  }
  if (req.url.startsWith('/api/apm/')) return json(sampleCrashPayload())
  if (req.url.includes('/reviews')) return json(sampleReviews())
  json({ ret: { code: 404, msg: 'not found' } }, 404)
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const env = {
  AGC_CLIENT_ID: 'example-client',
  AGC_CLIENT_SECRET: 'example-secret',
  AGC_BASE_URL: `http://127.0.0.1:${port}`,
}
const config = loadConfig(env)
const auth = new AuthProvider(config)
const client = new AgcClient(config, auth)
const registry = buildRegistry({ config, auth, client })

const write = (name, content) => {
  const file = join(outDir, name)
  writeFileSync(file, content, 'utf8')
  console.log(`wrote docs/examples/${name} (${Buffer.byteLength(content)} bytes)`)
}

try {
  // Overview of every numeric column, plus a focused trend on the primary
  // metric so the anomaly output is visible in the committed example.
  const overview = await registry.get('agc_report_trend').run({
    appId: '110012345',
    report: 'harmony-download',
    metric: '',
    startDate: '2026-05-01',
    endDate: '2026-05-30',
  })
  const focused = await registry.get('agc_report_trend').run({
    appId: '110012345',
    report: 'harmony-download',
    metric: '下载量',
    startDate: '2026-05-01',
    endDate: '2026-05-30',
  })
  write('report-trend.json', `${JSON.stringify({ overview: overview.overview, trend: focused.trend }, null, 2)}\n`)

  const daily = await registry.get('agc_daily_report').run({ appId: '110012345', date: '2026-05-30' })
  write('daily-report.md', daily.markdown.endsWith('\n') ? daily.markdown : `${daily.markdown}\n`)

  const weekly = await registry.get('agc_weekly_report').run({ appId: '110012345', endDate: '2026-05-30' })
  write('weekly-report.md', weekly.markdown.endsWith('\n') ? weekly.markdown : `${weekly.markdown}\n`)

  const insights = await registry.get('agc_review_insights').run({
    appId: '110012345',
    platform: 'harmonyos',
    begin: '2026-05-01',
    end: '2026-05-31',
    pages: 1,
  })
  write('review-insights.json', `${JSON.stringify(insights, null, 2)}\n`)

  console.log('\nexamples regenerated from the current code')
} finally {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}
