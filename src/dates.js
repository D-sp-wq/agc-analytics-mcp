/**
 * Date and range helpers.
 *
 * AGC report APIs speak `YYYYMMDD` (UTC) and cap export windows at 180 days;
 * review APIs speak millisecond timestamps (Beijing time on the wire) and cap
 * windows at 6 months. Both limits are validated client-side so the caller
 * gets a fixable message instead of an opaque server error.
 *
 * @module src/dates.js
 */

export const REPORT_MAX_RANGE_DAYS = 180
export const REVIEWS_MAX_RANGE_DAYS = 183

/** Parse `YYYY-MM-DD` / `YYYYMMDD` into {y,m,d}; null when invalid. */
function parseYmd(input) {
  const s = String(input ?? '').trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m === null) m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m === null) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return { y, m: mo, d }
}

/**
 * Validate a date string and return it normalized as YYYYMMDD.
 * Accepts `2026-01-31` and `20260131`.
 * @returns {string} YYYYMMDD
 */
export function ymd(input, { name = 'date' } = {}) {
  const parts = parseYmd(input)
  if (parts === null) {
    throw new Error(`${name} must be YYYY-MM-DD or YYYYMMDD (UTC), got "${input}"`)
  }
  return `${parts.y}${String(parts.m).padStart(2, '0')}${String(parts.d).padStart(2, '0')}`
}

/** ISO date (YYYY-MM-DD) of a timestamp, UTC. */
export function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Milliseconds since epoch for a validated YYYY-MM-DD, end-exclusive by default. */
export function toMillis(input, { endOfDay = false } = {}) {
  const parts = parseYmd(input)
  if (parts === null) {
    throw new Error(`date must be YYYY-MM-DD or YYYYMMDD (UTC), got "${input}"`)
  }
  const ms = Date.UTC(parts.y, parts.m - 1, parts.d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0)
  return ms
}

/**
 * Range validation for report exports. `start`/`end` accept the formats above.
 * @returns {{start: string, end: string}} YYYYMMDD pair
 */
export function reportRange(start, end, { maxDays = REPORT_MAX_RANGE_DAYS } = {}) {
  const s = ymd(start, { name: 'startDate' })
  const e = ymd(end, { name: 'endDate' })
  const from = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8))
  const to = Date.UTC(+e.slice(0, 4), +e.slice(4, 6) - 1, +e.slice(6, 8))
  const days = Math.round((to - from) / 86_400_000)
  if (days < 0) throw new Error(`startDate (${start}) is after endDate (${end})`)
  if (days > maxDays) throw new Error(`report range is ${days} days; the API allows at most ${maxDays}. Narrow the window or split the query`)
  return { start: s, end: e }
}

/** Day difference between two YYYYMMDD strings. */
export function daysBetween(a, b) {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8))
  const db = Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8))
  return Math.round((db - da) / 86_400_000)
}

/** Shift a YYYYMMDD string by n days (negative to go back). */
export function shiftYmd(ymdStr, n) {
  const t = Date.UTC(+ymdStr.slice(0, 4), +ymdStr.slice(4, 6) - 1, +ymdStr.slice(6, 8)) + n * 86_400_000
  const d = new Date(t)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * Is `day` (any date-ish string) inside [from, to] (both YYYYMMDD)?
 *
 * AGC normally honours the requested window, but an export that ignores it —
 * or one grouped by a non-date dimension — would otherwise be counted as if it
 * belonged to the window. Rows without a parseable date return `null` so the
 * caller can decide to keep them.
 *
 * @param {string} day
 * @param {string} from YYYYMMDD
 * @param {string} to YYYYMMDD
 * @returns {boolean|null}
 */
export function inWindow(day, from, to) {
  const m = /(\d{4})[-/]?(\d{2})[-/]?(\d{2})/.exec(String(day ?? ''))
  if (m === null) return null
  const compact = `${m[1]}${m[2]}${m[3]}`
  return compact >= from && compact <= to
}

/**
 * Keep the rows that belong to the window. Rows with no date column value are
 * kept: they cannot be judged, and dropping them would silently lose data in
 * country/version-grouped exports.
 *
 * @template {Record<string, string>} T
 * @param {T[]} rows
 * @param {string} dateColumn
 * @param {string} from YYYYMMDD
 * @param {string} to YYYYMMDD
 * @returns {{rows: T[], dropped: number}}
 */
export function filterRowsInWindow(rows, dateColumn, from, to) {
  if (dateColumn === '') return { rows, dropped: 0 }
  const kept = rows.filter(row => inWindow(row[dateColumn], from, to) !== false)
  return { rows: kept, dropped: rows.length - kept.length }
}
