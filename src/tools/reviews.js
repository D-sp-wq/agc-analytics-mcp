/**
 * Review tools: ratings summary, review listing, keyword insights.
 *
 * Reviews require the API-client credential — Service Accounts are refused by
 * these endpoints upstream, so the tools pass `preferred: ['api_client']` and
 * the error message explains the mismatch when only an SA is configured.
 *
 * @module src/tools/reviews.js
 */

import { validate, SITE_ARG } from '../schema.js'
import { toMillis, REVIEWS_MAX_RANGE_DAYS } from '../dates.js'
import { reviewInsights } from '../analytics/text.js'

function reviewArgs(extra = {}) {
  return {
    appId: { type: 'string', description: 'AGC appId' },
    platform: { type: 'string', enum: ['harmonyos', 'android'], description: 'harmonyos = HarmonyOS 5+ (v3 API); android = Android & HarmonyOS 4-' },
    begin: { type: 'string', description: 'Begin date YYYY-MM-DD (UTC). Default: 30 days ago' },
    end: { type: 'string', description: 'End date YYYY-MM-DD (UTC). Default: now' },
    countries: { type: 'string', description: 'Country codes, comma separated (default CN)' },
    ...SITE_ARG,
    ...extra,
  }
}

function windowMs(args) {
  const endMs = args.end !== undefined ? toMillis(args.end, { endOfDay: true }) : Date.now()
  const beginMs = args.begin !== undefined ? toMillis(args.begin) : endMs - 30 * 86_400_000
  const days = (endMs - beginMs) / 86_400_000
  if (days < 0) throw new Error('begin is after end')
  if (days > REVIEWS_MAX_RANGE_DAYS) {
    throw new Error(`review window is ${Math.round(days)} days; the API allows at most ${REVIEWS_MAX_RANGE_DAYS}. Narrow the range`)
  }
  return { beginMs, endMs }
}

function platformPath(platform, kind) {
  return platform === 'harmonyos'
    ? `/api/marketing-api/v2/reviews/manage/dev/${kind}`
    : `/api/reviews/v1/manage/dev/${kind}`
}

/**
 * @param {{client: import('../client.js').AgcClient}} deps
 */
export function reviewTools({ client }) {
  return [
    {
      name: 'agc_ratings_summary',
      title: 'Summarise app ratings',
      description: 'Fetch ratings for an app (average, star histogram) over a time window (max 6 months). Requires the API-client credential.',
      inputSchema: { type: 'object', properties: reviewArgs(), required: ['appId', 'platform'] },
      parse: args => validate(args, { appId: { type: 'string' }, platform: { type: 'string', enum: ['harmonyos', 'android'] }, ...SITE_ARG }, { required: ['appId', 'platform'] }),
      run: async args => {
        const { beginMs, endMs } = windowMs(args)
        const res = await client.call('GET', platformPath(args.platform, 'ratings'), {
          query: { appId: args.appId, beginTime: Math.floor(beginMs), endTime: Math.floor(endMs), countries: args.countries ?? 'CN' },
          site: args.site,
          preferred: ['api_client'],
        })
        return res.data
      },
    },
    {
      name: 'agc_reviews_list',
      title: 'List app reviews',
      description:
        'Fetch the review list with filters (rating, version, reply state, keyword, sort) — window max 6 months, page size max 100. ' +
        'Requires the API-client credential.',
      inputSchema: {
        type: 'object',
        properties: reviewArgs({
          ratings: { type: 'string', description: 'Star filter, e.g. "1,2"' },
          versions: { type: 'string', description: 'App version filter, comma separated' },
          devReplyStates: { type: 'string', description: '0 unreplied / 1 replied / 6 user follow-up / 3 reply-replied' },
          content: { type: 'string', description: 'Keyword filter inside review text' },
          sort: { type: 'number', enum: [0, 1, 2], description: '0 by time / 1 stars desc / 2 stars asc' },
          page: { type: 'number', description: '1-based page' },
          limit: { type: 'number', description: 'Page size, max 100 (default 20)' },
        }),
        required: ['appId', 'platform'],
      },
      parse: args => validate(args, {
        appId: { type: 'string' },
        platform: { type: 'string', enum: ['harmonyos', 'android'] },
        sort: { type: 'number', enum: [0, 1, 2] },
        page: { type: 'number', min: 1 },
        limit: { type: 'number', min: 1, max: 100 },
        ...SITE_ARG,
      }, { required: ['appId', 'platform'] }),
      run: async args => {
        const { beginMs, endMs } = windowMs(args)
        const versionKey = args.platform === 'harmonyos' ? 'appVersions' : 'apkVersions'
        const res = await client.call('GET', platformPath(args.platform, 'reviews'), {
          query: {
            appId: args.appId,
            beginTime: Math.floor(beginMs),
            endTime: Math.floor(endMs),
            countries: args.countries ?? 'CN',
            ratings: args.ratings,
            [versionKey]: args.versions,
            devReplyStates: args.devReplyStates,
            content: args.content,
            sort: args.sort,
            page: args.page,
            limit: args.limit,
          },
          site: args.site,
          preferred: ['api_client'],
        })
        return res.data
      },
    },
    {
      name: 'agc_review_insights',
      title: 'Cluster review keywords & star distribution',
      description:
        'Fetch reviews (up to 10 pages of 100) and analyse them: star histogram, average rating, top complaint/praise keywords '
        + '(CJK bigrams + Latin words), per-version negative hotspots. Set onlyNegative=true to focus on stars ≤ minRating (default 3). '
        + 'Requires the API-client credential.',
      inputSchema: {
        type: 'object',
        properties: reviewArgs({
          pages: { type: 'number', min: 1, max: 10, description: 'How many pages of 100 reviews to pull (default 3)' },
          onlyNegative: { type: 'boolean', description: 'Cluster only negative reviews' },
          minRating: { type: 'number', description: 'Rating ceiling for negative mode (default 3)' },
          topN: { type: 'number', min: 1, max: 30, description: 'Number of keyword clusters (default 10)' },
        }),
        required: ['appId', 'platform'],
      },
      parse: args => validate(args, {
        appId: { type: 'string' },
        platform: { type: 'string', enum: ['harmonyos', 'android'] },
        pages: { type: 'number', min: 1, max: 10 },
        minRating: { type: 'number' },
        topN: { type: 'number', min: 1, max: 30 },
        ...SITE_ARG,
      }, { required: ['appId', 'platform'] }),
      run: async args => {
        const { beginMs, endMs } = windowMs(args)
        const pages = args.pages ?? 3
        const versionKey = args.platform === 'harmonyos' ? 'appVersions' : 'apkVersions'
        const reviews = []
        for (let page = 1; page <= pages; page++) {
          const res = await client.call('GET', platformPath(args.platform, 'reviews'), {
            query: {
              appId: args.appId,
              beginTime: Math.floor(beginMs),
              endTime: Math.floor(endMs),
              countries: args.countries ?? 'CN',
              [versionKey]: args.versions,
              sort: 0,
              page,
              limit: 100,
            },
            site: args.site,
            preferred: ['api_client'],
          })
          const list = res.data?.reviews ?? res.data?.list ?? res.data?.value ?? []
          if (!Array.isArray(list) || list.length === 0) break
          for (const entry of list) {
            const e = /** @type {any} */ (entry)
            reviews.push({
              text: String(e.content ?? e.review ?? e.text ?? ''),
              rating: e.rating ?? e.stars ?? e.star,
              version: e.appVersion ?? e.apkVersion ?? e.version,
              date: e.reviewTime ?? e.createTime ?? e.date,
            })
          }
          if (list.length < 100) break
        }
        if (reviews.length === 0) return { note: 'no reviews found in this window', raw: reviews }
        return reviewInsights(reviews, { onlyNegative: args.onlyNegative, minRating: args.minRating, topN: args.topN })
      },
    },
  ]
}
