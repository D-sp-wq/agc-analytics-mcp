/**
 * Shared crash query used by both the crash tools and the digest tools.
 *
 * @module src/tools/crash-shared.js
 */

import { crashRequestBody, normalizeCrashRows } from '../analytics/crash.js'
import { toMillis, ymd } from '../dates.js'

/**
 * @param {import('../client.js').AgcClient} client
 * @param {{kind?: string, appId: string, startDate: string, endDate: string, site?: string, version?: string, dimension?: string}} args
 */
export async function crashToolsQuery(client, args) {
  const kind = args.kind === 'app-freeze' ? 'app-freeze' : 'crash'
  const path = kind === 'crash'
    ? '/api/apm/api/v1/hap/query/crash/metric'
    : '/api/apm/api/v1/hap/query/app-freeze/metric'
  const body = crashRequestBody({
    appId: args.appId,
    startMs: toMillis(ymd(args.startDate)),
    endMs: toMillis(ymd(args.endDate), { endOfDay: true }),
    dimension: args.dimension,
    version: args.version,
  })
  const res = await client.call('POST', path, { body, site: args.site })
  return { res, normalized: normalizeCrashRows(res.data) }
}
