/** Unit tests for the analytics layer: trend, text insights, crash shaping, digest rendering. */
import test from 'node:test'
import assert from 'node:assert/strict'

import { aggregateByDay, trendFor, trendOverview, dayOf, toNumber, movingAverage, lastZScore } from '../src/analytics/trend.js'
import { reviewInsights, tokenize } from '../src/analytics/text.js'
import { crashRequestBody, normalizeCrashRows, summarizeCrash } from '../src/analytics/crash.js'
import { dailyDigest, weeklyDigest } from '../src/analytics/digest.js'
import { sparkline } from '../src/format.js'

// ── trend ────────────────────────────────────────────────────────────────────

function makeRows(days, valueFn) {
  return days.map(day => ({ '日期': day, '下载量': String(valueFn(day)), '国家': 'CN' }))
}

test('dayOf extracts ISO and compact dates', () => {
  assert.equal(dayOf('2026-01-02'), '2026-01-02')
  assert.equal(dayOf('2026/01/02 12:00'), null)
  assert.equal(dayOf('20260102'), '2026-01-02')
  assert.equal(dayOf('active users'), null)
})

test('toNumber handles commas, k/M and Chinese units', () => {
  assert.equal(toNumber('1,234'), 1234)
  assert.equal(toNumber('2.5k'), 2500)
  assert.equal(toNumber('3M'), 3_000_000)
  assert.equal(toNumber('2万'), 20_000)
  assert.equal(toNumber(''), 0)
  assert.equal(toNumber('n/a'), 0)
})

test('aggregateByDay finds the date column and sums numerics', () => {
  const rows = makeRows(['2026-01-01', '2026-01-01', '2026-01-02'], () => 10)
  const agg = aggregateByDay(rows)
  assert.equal(agg.dateColumn, '日期')
  assert.ok(agg.columns.includes('下载量'))
  assert.equal(agg.byDay.get('2026-01-01').下载量, 20)
  assert.equal(agg.byDay.get('2026-01-02').下载量, 10)
})

test('trendFor reports direction, WoW and anomalies', () => {
  const days = []
  for (let i = 1; i <= 21; i++) days.push(`2026-01-${String(i).padStart(2, '0')}`)
  const rows = makeRows(days, day => (day === '2026-01-15' ? 10_000 : 100))
  const trend = trendFor(rows, '下载量')
  assert.equal(trend.error, undefined)
  assert.equal(trend.daysCovered, 21)
  assert.ok(['up', 'down', 'flat'].includes(trend.direction))
  assert.ok(trend.anomalyDays.some(a => a.day === '2026-01-15' && Math.abs(a.z) >= 2.5), 'spike day flagged')
  assert.equal(trend.peak.day, '2026-01-15')
  assert.ok(trend.sparkline.length > 0)
})

test('trendFor matches metrics by substring and reports available columns', () => {
  const rows = makeRows(['2026-01-01', '2026-01-02'], () => 5)
  const miss = trendFor(rows, '不存在')
  assert.equal(miss.error, 'metric "不存在" not found')
  assert.ok(miss.available.includes('下载量'))
  const hit = trendFor(rows, '下载')
  assert.equal(hit.metric, '下载量')
})

test('trendOverview summarises every numeric column', () => {
  const rows = makeRows(['2026-01-01', '2026-01-02'], () => 7).map(r => ({ ...r, '崩溃数': '1' }))
  const overview = trendOverview(rows)
  assert.equal(overview.metrics.length, 2)
  assert.ok(overview.metrics.every(m => ['up', 'down', 'flat'].includes(m.direction)))
})

test('movingAverage and lastZScore behave on known inputs', () => {
  // Centred window: edges average the values that exist.
  assert.deepEqual(movingAverage([1, 2, 3], 3), [1.5, 2, 2.5])
  const flat = [10, 11, 9, 10, 12, 8, 100]
  assert.ok(Math.abs(lastZScore(flat)) > 2, 'spike has high z')
})

test('sparkline renders a block per value', () => {
  assert.equal(sparkline([1, 2, 3, 4]).length, 4)
  assert.equal(sparkline([5, 5]), '▃▃')
  assert.equal(sparkline([1]), '')
})

// ── review text ──────────────────────────────────────────────────────────────

test('tokenize covers latin words and CJK bigrams', () => {
  const terms = tokenize('App keeps crashing after the update, 闪退得不行，更新后就闪退')
  assert.ok(terms.includes('crashing'))
  assert.ok(terms.includes('闪退'))
  assert.ok(!terms.includes('the'))
})

test('reviewInsights clusters terms and builds the star histogram', () => {
  const reviews = []
  for (let i = 0; i < 8; i++) reviews.push({ text: '登录失败，一直登录不了', rating: 1 })
  for (let i = 0; i < 5; i++) reviews.push({ text: '闪退，打开就闪退', rating: 1 })
  for (let i = 0; i < 6; i++) reviews.push({ text: '很好用，赞', rating: 5 })
  const insights = reviewInsights(reviews, { onlyNegative: true, minRating: 3 })
  assert.equal(insights.analysed, 19)
  assert.equal(insights.negativeAnalysed, 13)
  assert.equal(insights.histogram[5], 6)
  assert.equal(insights.averageRating, 2.26)
  const terms = insights.topTerms.map(t => t.term)
  assert.ok(terms.includes('登录'), `top terms: ${terms.join(',')}`)
  assert.ok(terms.includes('闪退'))
  assert.ok(insights.topTerms[0].examples.length >= 1)
})

// ── crash ────────────────────────────────────────────────────────────────────

test('crashRequestBody builds documented shape and drops undefined', () => {
  const body = crashRequestBody({ appId: 'app1', startMs: 1000, endMs: 2000, dimension: 'version', version: '1.2.0' })
  assert.deepEqual(body, { appId: 'app1', startTime: 1000, endTime: 2000, dim: 'version', appVersion: '1.2.0' })
  const minimal = crashRequestBody({ appId: 'a', startMs: 1, endMs: 2 })
  assert.deepEqual(Object.keys(minimal), ['appId', 'startTime', 'endTime'])
})

test('normalizeCrashRows reads list/rows/metrics shapes and passes unknown through', () => {
  const a = normalizeCrashRows({ value: { list: [{ date: '2026-01-01', count: '5', users: 2 }] } })
  assert.deepEqual(a.rows, [{ day: '2026-01-01', version: undefined, count: 5, users: 2, rate: undefined }])
  const b = normalizeCrashRows({ metrics: [{ appVersion: '1.0', crashCount: 3 }] })
  assert.equal(b.rows[0].count, 3)
  assert.equal(b.rows[0].version, '1.0')
  const c = normalizeCrashRows({ weird: true })
  assert.equal(c.rows.length, 0)
  assert.deepEqual(c.passthrough, { weird: true })
})

test('summarizeCrash totals, ranks versions and computes WoW', () => {
  const rows = [
    { day: '2026-01-01', version: '1.0', count: 10 },
    { day: '2026-01-02', version: '1.1', count: 5 },
    { day: '2026-01-08', version: '1.0', count: 20 },
  ]
  const summary = summarizeCrash(rows)
  assert.equal(summary.total, 35)
  assert.deepEqual(summary.byVersion, [{ version: '1.0', count: 30 }, { version: '1.1', count: 5 }])
  assert.equal(summary.daysCovered, 3)
  assert.equal(summary.last7Total, 35)
})

// ── digest ───────────────────────────────────────────────────────────────────

test('dailyDigest degrades failing sections instead of throwing', async () => {
  const md = await dailyDigest({
    date: '2026-01-15',
    appName: 'Demo',
    sections: [
      { title: 'OK section', promise: Promise.resolve('all good') },
      { title: 'Bad section', promise: Promise.reject(new Error('boom')) },
    ],
  })
  assert.ok(md.includes('# AGC Daily Report — 2026-01-15 — Demo'))
  assert.ok(md.includes('all good'))
  assert.ok(md.includes('## Bad section ⚠'))
  assert.ok(md.includes('boom'))
})

test('weeklyDigest renders WoW table rows', async () => {
  const md = await weeklyDigest({
    endDay: '2026-01-18',
    sections: [{
      title: 'Crashes',
      current: Promise.resolve({ totalLast7: 120, prev7Total: 100 }),
      previous: Promise.resolve({ totalLast7: 100 }),
    }],
  })
  assert.ok(md.includes('# AGC Weekly Report — week ending 2026-01-18'))
  assert.ok(md.includes('| last 7 days total | 120 |'))
  assert.ok(md.includes('+20.0% vs prev 100'))
})
