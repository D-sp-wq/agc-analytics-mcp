/**
 * Tolerant extraction of tabular data from an AGC response.
 *
 * Several AGC endpoints wrap their rows differently across versions and
 * platforms (`value.list`, `reviews.reviews`, a bare array, …) and the exact
 * envelope is not part of the public contract for every one of them. Rather
 * than guess a single shape and silently return nothing, the tools walk the
 * payload and take the largest array of objects they can find. Callers that
 * get no rows can still show the raw response.
 *
 * @module src/deep.js
 */

/**
 * Find the largest array of plain objects inside `data`.
 * @param {unknown} data
 * @param {{minItems?: number, maxDepth?: number}} [opts]
 * @returns {Array<Record<string, unknown>>}
 */
export function deepRows(data, opts = {}) {
  const minItems = opts.minItems ?? 1
  const maxDepth = opts.maxDepth ?? 6
  let best = []

  const walk = (node, depth) => {
    if (depth > maxDepth || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      const objects = node.filter(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
      if (objects.length > best.length) best = objects
      if (node.length > 0 && objects.length === 0) {
        for (const entry of node) walk(entry, depth + 1)
      }
      return
    }
    for (const value of Object.values(node)) walk(value, depth + 1)
  }

  walk(data, 0)
  return best.length >= minItems ? best : []
}

/**
 * Read a field from a row under any of several spellings.
 * @param {Record<string, unknown>} row
 * @param {string[]} keys
 */
export function pick(row, keys) {
  for (const key of keys) {
    const value = row?.[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/** First finite number among the given keys. */
export function pickNumber(row, keys) {
  for (const key of keys) {
    const value = Number(row?.[key])
    if (Number.isFinite(value)) return value
  }
  return undefined
}
