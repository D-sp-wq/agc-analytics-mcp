/**
 * Report tools: export one of the 16 report kinds, download and parse the
 * CSV, and run trend analytics over it.
 *
 * @module src/tools/reports.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { validate, SITE_ARG } from '../schema.js'
import { reportRange, shiftYmd, isoDay, filterRowsInWindow } from '../dates.js'
import { decodeCsv, csvRows } from '../csv.js'
import { trendFor, trendOverview, aggregateByDay } from '../analytics/trend.js'

/** Report catalogue: key → platform + upstream path. */
export const REPORTS = Object.freeze({
  'harmony-download': { platform: 'harmonyos', path: '/api/report/harmony-report/v1/harmony/appDownloadAnalysisExport/{appId}', desc: 'HarmonyOS app downloads & installs' },
  'harmony-install-failed': { platform: 'harmonyos', path: '/api/report/harmony-report/v1/harmony/installFailedAnalysisExport/{appId}', desc: 'HarmonyOS install failures' },
  'harmony-user-analysis': { platform: 'harmonyos', path: '/api/report/harmony-report/v1/harmony/userAnalysisExport/{appId}', desc: 'HarmonyOS user analysis (new/active/retention)' },
  'harmony-atomic-distribute': { platform: 'harmonyos', path: '/api/report/harmony-report/v1/fa/distributeAnalysisExport/{appId}', desc: 'HarmonyOS atomic service distribution' },
  download: { platform: 'android', path: '/api/report/distribution-operation-quality/v1/appDownloadExport/{appId}', desc: 'Downloads & installs (Android)' },
  'install-failed': { platform: 'android', path: '/api/report/distribution-operation-quality/v1/appDownloadFailExport/{appId}', desc: 'Install failures (Android)' },
  'new-and-retention': { platform: 'android', path: '/api/report/distribution-operation-quality/v1/addAdKpExport/{appId}', desc: 'New users & retention (Android)' },
  iap: { platform: 'android', path: '/api/report/distribution-operation-quality/v1/IAPExport/{appId}', desc: 'In-app purchases (Android)' },
  'paid-download': { platform: 'android', path: '/api/report/distribution-operation-quality/v1/orderAnalysisExport/{appId}', desc: 'Paid downloads (Android)' },
  'paid-download-detail': { platform: 'android', path: '/api/report/distribution-operation-quality/v1/orderDetailExport/{appId}', desc: 'Paid download details (Android)' },
  'game-reservation': { platform: 'android', path: '/api/report/distribution-operation-quality/v1/gameReservationExport/{appId}', desc: 'Game reservations (Android)' },
  'activity-award': { platform: 'android', path: '/api/report/distribution-operation-quality/v1/activityAwardExport/{appId}', desc: 'User-group award campaigns (Android)' },
  coupon: { platform: 'android', path: '/api/report/distribution-operation-quality/v1/activityCouponExport/{appId}', desc: 'Coupon campaigns (Android)' },
  'atomic-distribute': { platform: 'android', path: '/api/report/distribution-operation-quality/v1/fa/distributeAnalysisExport/{appId}', desc: 'Atomic service distribution (legacy, Android)' },
  'atomic-user': { platform: 'android', path: '/api/report/distribution-operation-quality/v1/fa/userAnalysisExport/{appId}', desc: 'Atomic service users (legacy, Android)' },
  'atomic-widget': { platform: 'android', path: '/api/report/distribution-operation-quality/v1/fa/widgetAnalysisExport/{appId}', desc: 'Atomic service widgets (legacy, Android)' },
})

/** Default export window: the 30 days ending yesterday (UTC). */
function defaultWindow() {
  const yesterday = isoDay(Date.now() - 86_400_000).replace(/-/g, '')
  return { start: shiftYmd(yesterday, -29), end: yesterday }
}

/**
 * @param {{client: import('../client.js').AgcClient}} deps
 */
export function reportTools({ client }) {
  /** Shared export → download → parse pipeline. */
  async function exportAndParse(args) {
    const def = REPORTS[args.report]
    const { start, end } = reportRange(args.startDate ?? defaultWindow().start, args.endDate ?? defaultWindow().end)
    const filters = Object.entries(args.filters ?? {})
    const res = await client.call('GET', def.path.replace('{appId}', encodeURIComponent(args.appId)), {
      site: args.site,
      query: {
        startTime: start,
        endTime: end,
        language: args.language ?? 'zh-CN',
        groupBy: args.groupBy,
        exportType: 'CSV',
        filterCondition: filters.map(([k]) => k),
        filterConditionValue: filters.map(([, v]) => v),
        ...args.extraQuery,
      },
    })
    const fileUrl = res.data?.fileURL ?? res.data?.fileUrl
    if (typeof fileUrl !== 'string' || fileUrl === '') {
      // Some report kinds answer with inline rows or an empty export.
      return { window: { start, end }, exportResponse: res.data, rows: [], header: [], csvText: '', note: 'no fileURL in export response; showing the raw export response' }
    }
    const file = await client.download(fileUrl)
    const text = decodeCsv(file.bytes)
    const parsed = csvRows(text)
    // AGC normally honours the requested window. When an export ignores it (or
    // is grouped by something other than the date), keeping the extra rows
    // would make every downstream number wrong — so the window is enforced
    // here, and what was dropped is reported.
    const aggregated = aggregateByDay(parsed.rows)
    const filtered = filterRowsInWindow(parsed.rows, aggregated.dateColumn, start, end)
    return {
      window: { start, end },
      header: parsed.header,
      rows: filtered.rows,
      rowsDroppedOutsideWindow: filtered.dropped,
      csvText: text,
    }
  }

  return [
    {
      name: 'agc_report_export',
      title: 'Export an AGC report as parsed rows',
      description:
        `Export an AGC operations report and return parsed rows. Reports: `
        + Object.entries(REPORTS).map(([k, v]) => `${k} (${v.platform}: ${v.desc})`).join('; ')
        + '. Window at most 180 days ending today. Rows are capped in the response (allRows=false); '
        + 'set outPath to also save the raw CSV on disk.',
      inputSchema: {
        type: 'object',
        properties: {
          appId: { type: 'string', description: 'AGC appId (see agc_list_apps / agc_get_app_id)' },
          report: { type: 'string', enum: Object.keys(REPORTS), description: 'Report kind' },
          startDate: { type: 'string', description: 'YYYY-MM-DD or YYYYMMDD (UTC). Default: 30 days ago' },
          endDate: { type: 'string', description: 'YYYY-MM-DD or YYYYMMDD (UTC). Default: yesterday' },
          groupBy: { type: 'string', description: 'date (default) / countryId / appVersion / deviceName / province / city — depends on report' },
          language: { type: 'string', enum: ['zh-CN', 'en-US', 'ru-RU'], description: 'Header language (default zh-CN)' },
          filters: { type: 'object', description: 'Filter map, e.g. {"countryId":"CN","appVersion":"1.0.0"}' },
          extraQuery: { type: 'object', description: 'Report-specific extra query params' },
          allRows: { type: 'boolean', description: 'Return every row instead of the first 500' },
          outPath: { type: 'string', description: 'Optional file path to save the raw CSV (must not exist unless overwrite=true)' },
          overwrite: { type: 'boolean', description: 'Allow overwriting outPath' },
          ...SITE_ARG,
        },
        required: ['appId', 'report'],
      },
      parse: args => {
        validate(args, {
          appId: { type: 'string' },
          report: { type: 'string', enum: Object.keys(REPORTS) },
          language: { type: 'string', enum: ['zh-CN', 'en-US', 'ru-RU'] },
          allRows: { type: 'boolean' },
          overwrite: { type: 'boolean' },
          ...SITE_ARG,
        }, { required: ['appId', 'report'] })
        reportRange(args.startDate ?? defaultWindow().start, args.endDate ?? defaultWindow().end)
        return args
      },
      run: async args => {
        const parsed = await exportAndParse(args)
        if (args.outPath !== undefined && args.outPath !== '') {
          const resolved = path.resolve(String(args.outPath))
          if (fs.existsSync(resolved) && args.overwrite !== true) {
            throw new Error(`outPath already exists: ${resolved}; pass overwrite=true to replace it`)
          }
          fs.mkdirSync(path.dirname(resolved), { recursive: true })
          fs.writeFileSync(resolved, parsed.csvText ?? '', 'utf8')
        }
        const limit = args.allRows === true ? Infinity : 500
        return {
          window: parsed.window,
          header: parsed.header,
          note: parsed.note,
          exportResponse: parsed.exportResponse,
          rowCount: parsed.rows.length,
          rows: parsed.rows.slice(0, limit),
          truncated: parsed.rows.length > limit,
          rowsDroppedOutsideWindow: parsed.rowsDroppedOutsideWindow ?? 0,
          savedTo: args.outPath !== undefined && args.outPath !== '' ? path.resolve(String(args.outPath)) : undefined,
        }
      },
    },
    {
      name: 'agc_report_trend',
      title: 'Trend analysis over an AGC report',
      description:
        'Export a report and analyse the trend of one metric: week-over-week change, 7-day moving-average direction, '
        + 'z-score anomaly days, peak/trough and a 28-day sparkline. Use metric="" to get a compact overview of all numeric columns.',
      inputSchema: {
        type: 'object',
        properties: {
          appId: { type: 'string' },
          report: { type: 'string', enum: Object.keys(REPORTS) },
          metric: { type: 'string', description: 'Column name to analyse (substring match ok); empty for overview of all columns' },
          startDate: { type: 'string', description: 'YYYY-MM-DD or YYYYMMDD (UTC). Default: 30 days ago' },
          endDate: { type: 'string', description: 'YYYY-MM-DD or YYYYMMDD (UTC). Default: yesterday' },
          groupBy: { type: 'string', description: 'usually keep the default (date)' },
          language: { type: 'string', enum: ['zh-CN', 'en-US', 'ru-RU'] },
          filters: { type: 'object' },
          ...SITE_ARG,
        },
        required: ['appId', 'report'],
      },
      parse: args => {
        validate(args, { appId: { type: 'string' }, report: { type: 'string', enum: Object.keys(REPORTS) }, ...SITE_ARG }, { required: ['appId', 'report'] })
        reportRange(args.startDate ?? defaultWindow().start, args.endDate ?? defaultWindow().end)
        return args
      },
      run: async args => {
        const parsed = await exportAndParse(args)
        if (parsed.rows.length === 0) return { note: 'no rows in this window', ...parsed }
        if (args.metric === undefined || args.metric === '') {
          return { window: parsed.window, overview: trendOverview(parsed.rows) }
        }
        return { window: parsed.window, trend: trendFor(parsed.rows, args.metric) }
      },
    },
  ]
}

/** Re-exported for digest tools. */
export { defaultWindow }
