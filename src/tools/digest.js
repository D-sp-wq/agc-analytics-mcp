/**
 * Digest tools: one-call daily and weekly Markdown reports.
 *
 * Every section runs through the same fetchers and analytics the standalone
 * tools use, so a digest is exactly the sum of the parts — and a failing
 * section degrades to a marked paragraph instead of sinking the report.
 *
 * @module src/tools/digest.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { validate, SITE_ARG } from '../schema.js'
import { ymd, shiftYmd, isoDay, filterRowsInWindow } from '../dates.js'
import { csvRows, decodeCsv } from '../csv.js'
import { dailyDigest, weeklyDigest } from '../analytics/digest.js'
import { trendFor, pickPrimaryMetric, trendLines, aggregateByDay } from '../analytics/trend.js'
import { summarizeCrash } from '../analytics/crash.js'
import { reviewInsights } from '../analytics/text.js'
import { deepRows, pick } from '../deep.js'
import { REPORTS, defaultWindow } from './reports.js'
import { crashToolsQuery } from './crash-shared.js'

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

/** Yesterday in UTC, as YYYYMMDD. */
function yesterdayYmd() {
  return isoDay(Date.now() - 86_400_000).replace(/-/g, '')
}

/**
 * @param {{client: import('../client.js').AgcClient}} deps
 */
export function digestTools({ client }) {
  /** Report rows for a window, decoded like every other report path. */
  async function reportRows(args, reportKey, startDay, endDay) {
    const def = REPORTS[reportKey]
    const res = await client.call('GET', def.path.replace('{appId}', encodeURIComponent(args.appId)), {
      site: args.site,
      query: { startTime: startDay, endTime: endDay, language: 'zh-CN', exportType: 'CSV' },
    })
    const fileUrl = res.data?.fileURL ?? res.data?.fileUrl
    if (typeof fileUrl !== 'string' || fileUrl === '') return []
    const file = await client.download(fileUrl)
    const rows = csvRows(decodeCsv(file.bytes)).rows
    // Same window enforcement as agc_report_export: an export that ignores the
    // requested range must not turn "this week" into "everything".
    const dateColumn = aggregateByDay(rows).dateColumn
    return filterRowsInWindow(rows, dateColumn, startDay, endDay).rows
  }

  /** Crash rows for a window via the shared query helper. */
  async function crashRows(args, kind, startDay, endDay) {
    const { normalized } = await crashToolsQuery(client, {
      kind,
      appId: args.appId,
      startDate: startDay,
      endDate: endDay,
      site: args.site,
    })
    return normalized
  }

  /** Reviews + keyword insight; a Service-Account-only setup fails the section. */
  async function reviewStats(args, startDay, endDay) {
    const platform = args.platform ?? 'harmonyos'
    const versionKey = platform === 'harmonyos' ? 'appVersions' : 'apkVersions'
    const toMs = day => Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`)
    const list = []
    for (let page = 1; page <= 3; page++) {
      const res = await client.call('GET', platform === 'harmonyos'
        ? '/api/marketing-api/v2/reviews/manage/dev/reviews'
        : '/api/reviews/v1/manage/dev/reviews', {
        query: {
          appId: args.appId,
          beginTime: toMs(startDay),
          endTime: toMs(endDay) + 86_399_999,
          countries: args.countries ?? 'CN',
          [versionKey]: undefined,
          sort: 0,
          page,
          limit: 100,
        },
        site: args.site,
        preferred: ['api_client'],
      })
      const rows = deepRows(res.data, { minItems: 1 })
      if (rows.length === 0) break
      for (const entry of rows) {
        list.push({
          text: String(pick(entry, ['content', 'review', 'text', 'reviewContent']) ?? ''),
          rating: pick(entry, ['rating', 'stars', 'star', 'score']),
          version: pick(entry, ['appVersion', 'apkVersion', 'version']),
        })
      }
      if (rows.length < 100) break
    }
    return reviewInsights(list, { onlyNegative: false, topN: 5 })
  }

  const reportArg = { type: 'string', enum: Object.keys(REPORTS), description: 'Report kind driving the download/install section (default harmony-download)' }

  return [
    {
      name: 'agc_daily_report',
      title: 'Build a one-day AGC report (Markdown)',
      description:
        'Build a daily operations digest for one day (default: yesterday): the 7-day download/install trend ending that day, '
        + 'crash/app-freeze totals, and a review snapshot. Each section degrades independently into a marked paragraph; '
        + 'the Markdown is returned and optionally written to outPath.',
      inputSchema: {
        type: 'object',
        properties: {
          appId: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD or YYYYMMDD (UTC). Default: yesterday' },
          report: reportArg,
          crashKind: { type: 'string', enum: ['crash', 'app-freeze'], description: 'Default crash' },
          platform: { type: 'string', enum: ['harmonyos', 'android'], description: 'Review platform (default harmonyos)' },
          countries: { type: 'string', description: 'Country codes for reviews (default CN)' },
          outPath: { type: 'string', description: 'Optional .md path to save the report' },
          overwrite: { type: 'boolean', description: 'Allow overwriting outPath' },
          ...SITE_ARG,
        },
        required: ['appId'],
      },
      parse: args => validate(args, {
        appId: { type: 'string' },
        report: reportArg,
        crashKind: { type: 'string', enum: ['crash', 'app-freeze'] },
        platform: { type: 'string', enum: ['harmonyos', 'android'] },
        overwrite: { type: 'boolean' },
        ...SITE_ARG,
      }, { required: ['appId'] }),
      run: async args => {
        const out = outPathGuard(args)
        const day = ymd(args.date ?? yesterdayYmd(), { name: 'date' })
        const weekStart = shiftYmd(day, -6)
        const reportKey = args.report ?? 'harmony-download'
        const crashKind = args.crashKind ?? 'crash'

        const markdown = await dailyDigest({
          date: day,
          sections: [
            {
              title: `Download & install trend (${reportKey}, 7 days to ${day})`,
              promise: reportRows(args, reportKey, weekStart, day).then(rows => {
                if (rows.length === 0) return '> no rows in this window'
                const aggregated = aggregateByDay(rows)
                const metric = pickPrimaryMetric(aggregated.columns)
                if (metric === null) return `> no numeric column found; columns: ${aggregated.columns.join(', ') || '(none)'}`
                return trendLines(trendFor(rows, metric)).join('\n')
              }),
            },
            {
              title: `Crash metrics (${crashKind}, 7 days to ${day})`,
              promise: crashRows(args, crashKind, weekStart, day).then(normalized => {
                if (normalized.rows.length !== 0) {
                  const summary = summarizeCrash(normalized.rows)
                  // No previous-week fetch in a daily digest, so no WoW claim:
                  // a comparison against zero would be misleading.
                  const average = summary.total / Math.max(1, summary.daysCovered)
                  const worst = summary.worstDays[0]
                  return [
                    `- crash events: ${summary.total} over ${summary.daysCovered} day(s) (${average.toFixed(1)}/day)`,
                    worst === undefined ? '- no per-day breakdown available' : `- worst day: ${worst.day} with ${worst.count}`,
                    summary.byVersion.length === 0
                      ? '- no version breakdown available'
                      : `- top versions: ${summary.byVersion.map(v => `${v.version} (${v.count})`).join(', ')}`,
                  ].join('\n')
                }
                if (normalized.passthrough !== undefined) {
                  return `> response shape not recognised (beta endpoint); raw payload:\n\`\`\`json\n${JSON.stringify(normalized.passthrough).slice(0, 800)}\n\`\`\``
                }
                return '> no crash rows in this window'
              }),
            },
            {
              title: 'Reviews snapshot (7 days)',
              promise: reviewStats(args, weekStart, day).then(insights => {
                const top = insights.topTerms.slice(0, 5).map(term => `${term.term} (${term.count})`).join(', ')
                return [
                  `- reviews analysed: ${insights.analysed}`,
                  `- average rating: ${insights.averageRating ?? 'n/a'}`,
                  `- stars: ${Object.entries(insights.histogram).map(([stars, count]) => `${stars}★ ${count}`).join(' · ')}`,
                  `- top keywords: ${top === '' ? '(none dominant)' : top}`,
                ].join('\n')
              }),
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
        'Build a weekly digest for the 7 days ending on endDate (default: yesterday): download/install totals with week-over-week '
        + 'comparison, crash totals with week-over-week, and the week\'s review keywords. The previous week is fetched '
        + 'automatically. Markdown is returned and optionally written to outPath.',
      inputSchema: {
        type: 'object',
        properties: {
          appId: { type: 'string' },
          endDate: { type: 'string', description: 'Week ends on this day, YYYY-MM-DD or YYYYMMDD (UTC). Default: yesterday' },
          report: reportArg,
          crashKind: { type: 'string', enum: ['crash', 'app-freeze'] },
          platform: { type: 'string', enum: ['harmonyos', 'android'], description: 'Review platform (default harmonyos)' },
          countries: { type: 'string' },
          outPath: { type: 'string' },
          overwrite: { type: 'boolean' },
          ...SITE_ARG,
        },
        required: ['appId'],
      },
      parse: args => validate(args, {
        appId: { type: 'string' },
        report: reportArg,
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

        /** Week totals for the primary metric of a report. */
        const weekTotals = async (from, to) => {
          const rows = await reportRows(args, reportKey, from, to)
          if (rows.length === 0) return { totalLast7: 0, notes: ['no report rows in this window'] }
          const aggregated = aggregateByDay(rows)
          const metric = pickPrimaryMetric(aggregated.columns)
          if (metric === null) return { totalLast7: 0, notes: ['no numeric column found in the report'] }
          const trend = trendFor(rows, metric)
          let total = 0
          for (const bucket of aggregated.byDay.values()) total += bucket[metric] ?? 0
          return { totalLast7: total, daysCovered: aggregated.byDay.size, metric, notes: trendLines(trend) }
        }

        const markdown = await weeklyDigest({
          endDay,
          sections: [
            {
              title: `Downloads & installs (${reportKey}, ${startDay} → ${endDay})`,
              current: weekTotals(startDay, endDay),
              previous: weekTotals(prevStart, prevEnd),
            },
            {
              title: `Crash metrics (${crashKind})`,
              current: crashRows(args, crashKind, startDay, endDay).then(normalized => {
                if (normalized.rows.length === 0) {
                  return normalized.passthrough !== undefined
                    ? { totalLast7: 0, notes: [`response shape not recognised (beta endpoint): ${JSON.stringify(normalized.passthrough).slice(0, 300)}`] }
                    : { totalLast7: 0, notes: ['no crash rows this week'] }
                }
                const days = new Set(normalized.rows.map(row => row.day).filter(Boolean))
                const versions = new Map()
                for (const row of normalized.rows) {
                  if (row.version !== undefined) versions.set(row.version, (versions.get(row.version) ?? 0) + row.count)
                }
                const topVersions = [...versions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
                return {
                  totalLast7: normalized.rows.reduce((sum, row) => sum + row.count, 0),
                  daysCovered: days.size,
                  notes: topVersions.length === 0 ? [] : [`top versions: ${topVersions.map(([v, c]) => `${v} (${c})`).join(', ')}`],
                }
              }),
              previous: crashRows(args, crashKind, prevStart, prevEnd).then(normalized => ({
                totalLast7: normalized.rows.reduce((sum, row) => sum + row.count, 0),
              })),
            },
            {
              title: 'Review keywords',
              current: reviewStats(args, startDay, endDay).then(insights => {
                const top = insights.topTerms.slice(0, 5).map(term => `${term.term} (${term.count})`).join(', ')
                return [
                  `- reviews analysed: ${insights.analysed}`,
                  `- average rating: ${insights.averageRating ?? 'n/a'}`,
                  `- top keywords: ${top === '' ? '(none dominant)' : top}`,
                  `- negative hotspots by version: ${insights.negativeByVersion.map(v => `${v.version} (${v.count})`).join(', ') || '(none)'}`,
                ].join('\n')
              }),
            },
          ],
        })
        return { markdown, savedTo: writeOut(out, markdown) }
      },
    },
  ]
}
