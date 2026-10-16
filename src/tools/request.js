/**
 * The generic read-only passthrough — the escape hatch for endpoints this
 * package has no dedicated tool for (new report kinds, extra APM filters…).
 *
 * The whitelist is the security boundary: only read-only AGC data paths are
 * allowed. Anything outside the prefixes below is refused with the list of
 * acceptable prefixes, so a prompt-injected or hallucinated call can never
 * publish, upload, delete or reply.
 *
 * @module src/tools/request.js
 */

import { validate, SITE_ARG } from '../schema.js'

const ALLOWED_PREFIXES = Object.freeze([
  '/api/report/',
  '/api/apm/',
  '/api/project-service/v1/projects',
  '/api/publish/v2/appid-list',
  '/api/publish/v2/app-info', // GET-only enforced below
  '/api/marketing-api/v2/reviews/manage/dev/ratings',
  '/api/marketing-api/v2/reviews/manage/dev/reviews', // GET-only enforced below
  '/api/reviews/v1/manage/dev/ratings',
  '/api/reviews/v1/manage/dev/reviews',
])

/** Only GET may touch the review endpoints (replying is a write). */
const GET_ONLY = Object.freeze([
  '/api/marketing-api/v2/reviews/manage/dev/reviews',
  '/api/reviews/v1/manage/dev/reviews',
  '/api/publish/v2/app-info',
])

/**
 * @param {{client: import('../client.js').AgcClient}} deps
 */
export function requestTool({ client }) {
  return [
    {
      name: 'agc_request',
      title: 'Call a whitelisted read-only AGC endpoint',
      description:
        'Generic GET/POST passthrough for AGC Connect API read endpoints without a dedicated tool. '
        + `Allowed path prefixes: ${ALLOWED_PREFIXES.join(', ')}. Review/app-info paths accept GET only. `
        + 'Write operations (publish, upload, reply, delete) are not callable through this tool by design.',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method (default GET)' },
          path: { type: 'string', description: 'API path beginning with /api/' },
          query: { type: 'object', description: 'Query parameters as a string→string map' },
          body: { type: 'object', description: 'JSON body for POST' },
          ...SITE_ARG,
        },
        required: ['path'],
      },
      parse: args => guardPassthrough(args),
      run: async rawArgs => {
        // Guard again: run() must never depend on parse() having been called.
        const args = guardPassthrough(rawArgs)
        const res = await client.call(args.method, args.path, { query: args.query, body: args.body, site: args.site })
        return { status: res.status, data: res.data }
      },
    },
  ]
}

/**
 * The whitelist check, applied on every path into the tool.
 * @param {Record<string, any>} args
 */
function guardPassthrough(args) {
  validate(args, { method: { type: 'string', enum: ['GET', 'POST'] }, ...SITE_ARG }, { required: ['path'] })
  let pathname
  try {
    pathname = new URL(String(args.path), 'https://placeholder.invalid').pathname
  } catch {
    throw new Error('path must be a valid API path beginning with /api/')
  }
  if (!pathname.startsWith('/api/')) throw new Error('path must begin with /api/')
  const allowed = ALLOWED_PREFIXES.some(prefix => pathname.startsWith(prefix))
  if (!allowed) {
    throw new Error(`path "${pathname}" is not in the read-only whitelist. Allowed prefixes: ${ALLOWED_PREFIXES.join(', ')}`)
  }
  const method = args.method ?? 'GET'
  if (method !== 'GET' && GET_ONLY.some(prefix => pathname.startsWith(prefix))) {
    throw new Error(`"${pathname}" accepts GET only through this tool (write operations are disabled by design)`)
  }
  return { ...args, method, path: pathname }
}
