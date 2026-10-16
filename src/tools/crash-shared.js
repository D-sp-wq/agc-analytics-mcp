/**
 * Shared crash query used by both the crash tools and the digest tools.
 *
 * @module src/tools/crash-shared.js
 */

import { crashRequestBody, normalizeCrashRows } from '../analytics/crash.js'
import { toMillis, ymd, inWindow } from '../dates.js'

/**
 * Query the APM crash / app-freeze metric endpoint and normalise the rows.
 *
 * Rows carrying a date outside the requested window are dropped: some
 * deployments answer a metric query with the whole stored series, and mixing
 * that into a "this week" number would be silently wrong. Rows without a date
 * (version-only breakdowns) are kept.
 *
 * @param {import('../client.js').AgcClient} client
 * @param {{kind?: string, appId: string, startDate: string, endDate: string, site?: string, version?: string, dimension?: string}} args
 */
export async function crashToolsQuery(client, args) {
  const kind = args.kind === 'app-freeze' ? 'app-freeze' : 'crash'
  const path = kind === 'crash'
    ? '/api/apm/api/v1/hap/query/crash/metric'
    : '/api/apm/api/v1/hap/query/app-freeze/metric'
  const start = ymd(args.startDate)
  const end = ymd(args.endDate)
  const body = crashRequestBody({
    appId: args.appId,
    startMs: toMillis(start),
    endMs: toMillis(end, { endOfDay: true }),
    dimension: args.dimension,
    version: args.version,
  })
  const res = await client.call('POST', path, { body, site: args.site })
  const normalized = normalizeCrashRows(res.data)
  const rows = normalized.rows.filter(row => row.day === undefined || inWindow(row.day, start, end) !== false)
  return {
    res,
    normalized: {
      ...normalized,
      rows,
      rowsDroppedOutsideWindow: normalized.rows.length - rows.length,
    },
    window: { start, end },
  }
}
