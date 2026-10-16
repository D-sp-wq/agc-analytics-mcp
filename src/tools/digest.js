/**
 * Digest tools: one-call daily and weekly Markdown reports.
 *
 * Every section runs through the same fetchers the standalone tools use; a
 * section failure degrades to a marked paragraph (the report still ships).
 *
 * @module src/tools/digest.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { validate, SITE_ARG } from '../schema.js'
import { ymd, shiftYmd, isoDay } from '../dates.js'
import { dailyDigest, weeklyDigest } from '../analytics/digest.js'
import { REPORTS, defaultWindow } from './reports.js'
import { crashToolsQuery } from './crash-shared.js'
import { reviewInsights } from '../analytics/text.js'

function outPathGuard(args) {
  if (args.outPath === undefined || args.outPath === '') return undefined
  const resolved = path.resolve(String(args.outPath))
  if (fs.existsSync(resolved) && args.overwrite !== true) {
    throw new Error(`outPath already exists: ${resolved}; pass overwrite=true to replace it`)
  }
  return resolved
}

function writeOut(resolved, markdown) {
  if (resolved === undefined) return undefined
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, markdown, 'utf8')
  return resolved
}

/**
 * @param {{client: import('../client.js').AgcClient}} deps
 */
export function digestTools({ client }) {
  /** Crash rows via the shared query helper. */
  async function crashRows(args, startDay, endDay) {
    const { normalized } = await crashToolsQuery(client, {
      kind: args.kind ?? 'crash',
      appId: args.appId,
      startDate: startDay,
      endDate: endDay,
      site: args.site,
    })
    return normalized
  }

  /** Report rows for a window. */
  async function reportRows(args, reportKey, startDay, endDay) {
    const def = REPORTS[reportKey]
    const res = await client.call('GET', def.path.replace('{appId}', encodeURIComponent(args.appId)), {
      site: args.site,
      query: { startTime: startDay, endTime: endDay, language: 'zh-CN', exportType: 'CSV' },
    })
    const fileUrl = res.data?.fileURL ?? res.data?.fileUrl
    if (typeof fileUrl !== 'string' || fileUrl === '') return []
    const file = await client.download(fileUrl)
    const { csvRows } = await import('../csv.js')
    return csvRows(file.bytes.toString('utf8').replace(/^\uFEFF/, '')).rows
  }

  /** Reviews for insight; errors (SA-only setups) propagate to the section. */
  async function pullReviews(args, startDay, endDay) {
    const versionKey = args.platform === 'harmonyos' ? 'appVersions' : 'apkVersions'
    const list = []
    for (let page = 1; page <= 3; page++) {
      const res = await client.call('GET', args.platform === 'harmonyos'
        ? '/api/marketing-api/v2/reviews/manage/dev/reviews'
        : '/api/reviews/v1/manage/dev/reviews', {
        query: {
          appId: args.appId,
          beginTime: Date.parse(`${startDay.slice(0, 4)}-${startDay.slice(4, 6)}-${startDay.slice(6, 8)}T00:00:00Z`),
          endTime: Date.parse(`${endDay.slice(0, 4)}-${endDay.slice(4, 6)}-${endDay.slice(6, 8)}T23:59:59Z`),
          countries: args.countries ?? 'CN',
          [versionKey]: undefined,
          sort: 0,
          page,
          limit: 100,
        },
        site: args.site,
        preferred: ['api_client'],
      })
      const rows = res.data?.reviews ?? res.data?.list ?? res.data?.value ?? []
      if (!Array.isArray(rows) || rows.length === 0) break
      for (const e of rows) {
        list.push({ text: String(e.content ?? e.review ?? ''), rating: e.rating ?? e.stars, version: e.appVersion ?? e.apkVersion })
      }
      if (rows.length < 100) break
    }
    return reviewInsights(list, { onlyNegative: false, topN: 5 })
  }

  return [
    {
      name: 'agc_daily_report',
      title: 'Build a one-day AGC report (Markdown)',
      description:
        'Build a daily operations digest for one day (default: yesterday): download/install report, crash metrics, ratings snapshot. ' +
        'Each section degrades independently; the report is returned as Markdown and can be saved with outPath.',
      inputSchema: {
        type: 'object',
        properties: {
          appId: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD or YYYYMMDD (UTC). Default: yesterday' },
          crashKind: { type: 'string', enum: ['crash', 'app-freeze'], description: 'Default crash' },
          outPath: { type: 'string', description: 'Optional .md path to save the report' },
          overwrite: { type: 'boolean' },
          ...SITE_ARG,
        },
        required: ['appId'],
      },
      parse: args => validate(args, { appId: { type: 'string' }, crashKind: { type: 'string', enum: ['crash', 'app-freeze'] }, overwrite: { type: 'boolean' }, ...SITE_ARG }, { required: ['appId'] }),
      run: async args => {
        const out = outPathGuard(args)
        const day = ymd(args.date ?? isoDay(Date.now() - 86_400_000).replace(/-/g, ''), { name: 'date' })
        const reportKey = args._reportKey ?? 'harmony-download'
        const markdown = await dailyDigest({
          date: day,
          sections: [
            {
              title: `Downloads & installs (${reportKey})`,
              promise: reportRows(args, reportKey, day, day).then(rows => {
                if (rows.length === 0) return 'no rows for this day'
                return '```csv\n' + rows.map(r => Object.values(r).join(',')).slice(0, 20).join('\n') + '\n```'
              }),
            },
            {
              title: 'Crash metrics',
              promise: crashRows(args, day, day).then(normalized => {
                if (normalized.rows.length !== 0) return JSON.stringify(normalized.rows.slice(0, 20), null, 2)
                if (normalized.passthrough !== undefined) return `raw response (shape not recognised):\n${JSON.stringify(normalized.passthrough).slice(0, 800)}`
                return 'no crash rows for this day'
              }),
            },
            {
              title: 'Ratings & reviews snapshot',
              promise: pullReviews(args, day, day).then(insights => `average rating: ${insights.averageRating ?? 'n/a'}; reviews analysed: ${insights.analysed}`),
            },
          ],
        })
        return { markdown, savedTo: writeOut(out, markdown) }
      },
    },
    {
      name: 'agc_weekly_report',
      title: 'Build a weekly AGC report with WoW comparison (Markdown)',
      description:
        'Build a weekly digest for the 7 days ending on endDate (default: yesterday): report totals + trend direction, ' +
        'crash WoW, review keywords. The previous week is fetched automatically for comparisons. Saved with outPath if given.',
      inputSchema: {
        type: 'object',
        properties: {
          appId: { type: 'string' },
          endDate: { type: 'string', description: 'Week ends on this day, YYYY-MM-DD or YYYYMMDD (UTC). Default: yesterday' },
          report: { type: 'string', enum: Object.keys(REPORTS), description: 'Which report drives the download/trend section (default harmony-download)' },
          crashKind: { type: 'string', enum: ['crash', 'app-freeze'] },
          platform: { type: 'string', enum: ['harmonyos', 'android'], description: 'Review platform (default harmonyos)' },
          outPath: { type: 'string' },
          overwrite: { type: 'boolean' },
          ...SITE_ARG,
        },
        required: ['appId'],
      },
      parse: args => validate(args, {
        appId: { type: 'string' },
        report: { type: 'string', enum: Object.keys(REPORTS) },
        crashKind: { type: 'string', enum: ['crash', 'app-freeze'] },
        platform: { type: 'string', enum: ['harmonyos', 'android'] },
        overwrite: { type: 'boolean' },
        ...SITE_ARG,
      }, { required: ['appId'] }),
      run: async args => {
        const out = outPathGuard(args)
        const endDay = ymd(args.endDate ?? defaultWindow().end, { name: 'endDate' })
        const startDay = shiftYmd(endDay, -6)
        const prevStart = shiftYmd(endDay, -13)
        const prevEnd = shiftYmd(endDay, -7)
        const reportKey = args.report ?? 'harmony-download'
        const crashKind = args.crashKind ?? 'crash'
        const platform = args.platform ?? 'harmonyos'

        const markdown = await weeklyDigest({
          endDay,
          sections: [
            {
              title: `Downloads & installs (${reportKey})`,
              current: reportRows(args, reportKey, startDay, endDay).then(rows => {
                if (rows.length === 0) return 'no rows this week'
                // Compact textual trend: sum of numeric columns per day.
                const byDay = new Map()
                for (const row of rows) {
                  const dayCell = Object.values(row).find(v => /\d{4}-\d{2}-\d{2}|\d{8}/.test(String(v)))
                  if (dayCell === undefined) continue
                  const day = String(dayCell).slice(0, 10).replace(/-/g, '')
                  const nums = Object.values(row).map(Number).filter(Number.isFinite)
                  byDay.set(day, (byDay.get(day) ?? 0) + Math.max(0, ...nums.slice(0, 3)))
                }
                const days = [...byDay.keys()].sort()
                return `days with data: ${days.length}; first ${days[0] ?? '—'}, last ${days[days.length - 1] ?? '—'}; activity proxy: ${[...byDay.values()].slice(-7).join(', ')}`
              }),
              previous: reportRows(args, reportKey, prevStart, prevEnd).then(rows => ({ totalLast7: rows.length })),
            },
            {
              title: `Crash metrics (${crashKind})`,
              current: crashRows({ ...args, kind: crashKind }, startDay, endDay).then(normalized => {
                if (normalized.rows.length === 0) return normalized.passthrough !== undefined
                  ? `shape not recognised: ${JSON.stringify(normalized.passthrough).slice(0, 400)}`
                  : 'no crash rows this week'
                const total = normalized.rows.reduce((a, r) => a + r.count, 0)
                return { totalLast7: total, daysCovered: new Set(normalized.rows.map(r => r.day).filter(Boolean)).size }
              }),
              previous: crashRows({ ...args, kind: crashKind }, prevStart, prevEnd).then(normalized => ({ totalLast7: normalized.rows.reduce((a, r) => a + r.count, 0) })),
            },
            {
              title: 'Review keywords',
              current: pullReviews({ ...args, platform }, startDay, endDay).then(insights => {
                const top = insights.topTerms.slice(0, 5).map(t => `${t.term} (${t.count})`).join(', ')
                return top === '' ? 'no dominant keywords' : `average ${insights.averageRating ?? 'n/a'}; top terms: ${top}`
              }),
            },
          ],
        })
        return { markdown, savedTo: writeOut(out, markdown) }
      },
    },
  ]
}
