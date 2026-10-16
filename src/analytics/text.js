/**
 * Review-text insights — keyword clustering with zero dependencies.
 *
 * Chinese has no spaces, so tokenisation is character-bigram frequency with a
 * small stoplist of function-word bigrams; Latin text is word-tokenised. The
 * clusters are then the top-N frequent terms with a few example reviews each.
 * This is intentionally simple — a term-frequency lens, not an NLP pipeline —
 * but it reliably surfaces "闪退", "登录", "update broke" style themes.
 *
 * @module src/analytics/text.js
 */

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/
const WORD_RE = /[a-zA-Z][a-zA-Z0-9'_-]{1,}/g

const CJK_STOPLIST = new Set(['的了', '是我', '这个', '一个', '什么', '没有', '就是', '但是', '还是', '可以', '你们', '我们', '他们', '自己', '时候', '现在', '这样', '那样', '一下', '不了', '不能', '不会', '不错'])
const WORD_STOPLIST = new Set(['the', 'and', 'for', 'you', 'your', 'this', 'that', 'with', 'have', 'has', 'was', 'were', 'but', 'not', 'are', 'its', "it's", 'from', 'will', 'can', 'all', 'out', 'get', 'got', 'app', '应用', '软件', 'very', 'too', 'also', 'just', 'one', 'when', 'what', 'why', 'how', 'who'])

/** Split one review into lowercase candidate terms. */
export function tokenize(text) {
  const s = String(text ?? '')
  const terms = []
  for (const match of s.matchAll(WORD_RE)) {
    const word = match[0].toLowerCase()
    if (word.length >= 3 && !WORD_STOPLIST.has(word)) terms.push(word)
  }
  if (CJK_RE.test(s)) {
    // Drop punctuation/space runs so bigrams stay inside phrases.
    const chunks = s.split(/[^\u3400-\u9fff\uf900-\ufaff]+/).filter(c => c.length >= 2)
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length - 1; i++) {
        const bigram = chunk.slice(i, i + 2)
        if (!CJK_STOPLIST.has(bigram)) terms.push(bigram)
      }
    }
  }
  return terms
}

/**
 * Cluster reviews by their most salient shared term.
 * @param {Array<{text: string, rating?: number|string, version?: string, date?: string}>} reviews
 * @param {{topN?: number, examples?: number, minRating?: number, onlyNegative?: boolean}} [opts]
 */
export function reviewInsights(reviews, opts = {}) {
  const topN = opts.topN ?? 10
  const exampleCount = opts.examples ?? 2
  const pool = opts.onlyNegative === true
    ? reviews.filter(r => r.rating !== undefined && Number(String(r.rating).replace(/[^0-9.]/g, '')) <= (opts.minRating ?? 3))
    : reviews

  const termStats = new Map()
  for (const review of pool) {
    const terms = new Set(tokenize(review.text))
    for (const term of terms) {
      const stat = termStats.get(term) ?? { count: 0, reviews: [] }
      stat.count += 1
      if (stat.reviews.length < exampleCount) stat.reviews.push(review)
      termStats.set(term, stat)
    }
  }
  // Terms that appear in at least 3 reviews and are not substrings of a
  // more frequent term (keeps 闪退 over 退 alone).
  const candidates = [...termStats.entries()]
    .filter(([, stat]) => stat.count >= 3)
    .sort((a, b) => b[1].count - a[1].count)
  const chosen = []
  for (const [term, stat] of candidates) {
    if (chosen.some(t => t.term.includes(term) || term.includes(t.term))) continue
    chosen.push({ term, count: stat.count, examples: stat.reviews.map(r => ({ rating: r.rating, version: r.version, date: r.date, text: String(r.text).slice(0, 120) })) })
    if (chosen.length >= topN) break
  }

  // Star distribution and the negative count (independent of the pool mode).
  const histogram = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  let rated = 0
  let sum = 0
  let negativeCount = 0
  const negativeCeiling = opts.minRating ?? 3
  for (const review of reviews) {
    const stars = Number(String(review.rating ?? '').replace(/[^0-9.]/g, ''))
    if (!Number.isFinite(stars) || stars <= 0) continue
    const bucket = Math.min(5, Math.max(1, Math.round(stars)))
    histogram[bucket] += 1
    rated += 1
    sum += stars
    if (stars <= negativeCeiling) negativeCount += 1
  }

  // Version hotspots: reviews in the clustering pool grouped by version.
  const byVersion = new Map()
  for (const review of pool) {
    const version = String(review.version ?? '').trim()
    if (version === '') continue
    byVersion.set(version, (byVersion.get(version) ?? 0) + 1)
  }

  return {
    /** Reviews read from the API. */
    analysed: reviews.length,
    /** Reviews that went into the keyword clustering (all, or negatives only). */
    clustered: pool.length,
    /** Reviews at or below the negative rating ceiling, always computed. */
    negativeCount,
    pool: opts.onlyNegative === true ? 'negative-only' : 'all',
    averageRating: rated !== 0 ? Number((sum / rated).toFixed(2)) : null,
    histogram,
    topTerms: chosen,
    negativeByVersion: [...byVersion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([version, count]) => ({ version, count })),
    /** Reviews in the pool that rated the app at or below the ceiling. */
    negativeInPool: pool.filter(review => {
      const stars = Number(String(review.rating ?? '').replace(/[^0-9.]/g, ''))
      return Number.isFinite(stars) && stars > 0 && stars <= negativeCeiling
    }).length,
  }
}
