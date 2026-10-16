/**
 * Crash tools: raw crash/app-freeze metric queries plus a summariser.
 *
 * @module src/tools/crash.js
 */

import { validate, SITE_ARG } from '../schema.js'
import { summarizeCrash } from '../analytics/crash.js'
import { crashToolsQuery } from './crash-shared.js'

/**
 * @param {{client: import('../client.js').AgcClient}} deps
 */
export function crashTools({ client }) {
  /** Last 30 days ending today (UTC) — the default window. */
  function withWindow(args) {
    if (args.startDate !== undefined && args.endDate !== undefined) return args
    const endDay = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const startDay = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '')
    return { ...args, startDate: args.startDate ?? startDay, endDate: args.endDate ?? endDay }
  }

  /** One query path for both the crash tools and the digests. */
  async function query(kind, rawArgs) {
    const args = withWindow(rawArgs)
    return crashToolsQuery(client, { ...args, kind })
  }

  const commonArgs = {
    appId: { type: 'string', description: 'AGC appId' },
    kind: { type: 'string', enum: ['crash', 'app-freeze'], description: 'Metric kind (default crash)' },
    startDate: { type: 'string', description: 'YYYY-MM-DD or YYYYMMDD (UTC)' },
    endDate: { type: 'string', description: 'YYYY-MM-DD or YYYYMMDD (UTC)' },
    dimension: { type: 'string', enum: ['day', 'version'], description: 'Group the metric by day or by app version' },
    version: { type: 'string', description: 'Filter to one app version' },
    ...SITE_ARG,
  }

  function parseCommon(args) {
    validate(args, { appId: { type: 'string' }, kind: { type: 'string', enum: ['crash', 'app-freeze'] }, dimension: { type: 'string', enum: ['day', 'version'] }, ...SITE_ARG }, { required: ['appId'] })
    return withWindow(args)
  }

  return [
    {
      name: 'agc_crash_metric',
      title: 'Query crash / app-freeze metrics',
      description:
        'Query AGC APM crash or app-freeze metrics (POST /api/apm/api/v1/hap/query/{kind}/metric) and return normalised rows '
        + '{day, version, count, users, rate}. If the gateway rejects the body shape, the raw response is returned with a note; ' +
        'use agc_request to adjust fields. This endpoint is community-verified; schema drift is possible.',
      inputSchema: { type: 'object', properties: commonArgs, required: ['appId'] },
      parse: parseCommon,
      run: async args => {
        const { res, normalized } = await query(args.kind ?? 'crash', args)
        return normalized.rows.length !== 0
          ? { rows: normalized.rows }
          : { note: 'unrecognised response shape; returning raw payload', raw: res.data }
      },
    },
    {
      name: 'agc_crash_summary',
      title: 'Summarise crash / app-freeze metrics',
      description:
        'Query crash or app-freeze metrics and summarise: total, last-7 vs previous-7 (WoW), worst days, top affected versions, daily series.',
      inputSchema: { type: 'object', properties: commonArgs, required: ['appId'] },
      parse: parseCommon,
      run: async args => {
        const { normalized } = await query(args.kind ?? 'crash', args)
        if (normalized.rows.length === 0) {
          return { note: 'no crash rows recognised for this window', raw: normalized.passthrough }
        }
        return summarizeCrash(normalized.rows)
      },
    },
  ]
}
