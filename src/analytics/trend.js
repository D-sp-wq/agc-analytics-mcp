/**
 * Trend analytics over daily report rows — pure functions, no I/O, fully
 * offline-testable.
 *
 * Input rows come from `agc_report_export`'s CSV parse: objects with a date-ish
 * column and numeric metric columns. The functions below aggregate by day,
 * compare week-over-week, detect direction with a 7-point moving-average
 * slope, and flag anomaly days with a z-score.
 *
 * @module src/analytics/trend.js
 */

import { shiftYmd } from '../dates.js'
import { sparkline } from '../format.js'

/** Extract `YYYY-MM-DD`/`YYYYMMDD` from a cell; null when the cell has no date. */
export function dayOf(cell) {
  const s = String(cell ?? '').trim()
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m === null) m = /(\d{4})(\d{2})(\d{2})/.exec(s)
  if (m === null) return null
  const y = +m[1]; const mo = +m[2]; const d = +m[3]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const NUMBER_RE = /^-?[\d,.]+\s*[kKmM万亿]?$/

/** Parse a report cell into a finite number; 0 for blanks. */
export function toNumber(cell) {
  if (cell === undefined || cell === null) return 0
  let s = String(cell).trim().replace(/,/g, '')
  if (s === '') return 0
  let scale = 1
  const unit = /([kKmM万亿])$/.exec(s)
  if (unit !== null) {
    scale = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, '万': 1e4, '亿': 1e8 }[unit[1]]
    s = s.slice(0, -1)
  }
  const n = Number(s)
  return Number.isFinite(n) ? n * scale : 0
}

export function looksNumeric(cell) {
  return cell !== undefined && cell !== null && cell !== '' && NUMBER_RE.test(String(cell).trim())
}

/**
 * Group rows by day, summing numeric columns.
 * @param {Array<Record<string, string>>} rows
 * @returns {{dateColumn: string, columns: string[], byDay: Map<string, Record<string, number>>}}
 */
export function aggregateByDay(rows) {
  if (rows.length === 0) return { dateColumn: '', columns: [], byDay: new Map() }
  // The date column is the one where the most rows yield a date.
  let dateColumn = ''
  let best = 0
  for (const key of Object.keys(rows[0])) {
    const hits = rows.filter(r => dayOf(r[key]) !== null).length
    if (hits > best) { best = hits; dateColumn = key }
  }
  const numeric = Object.keys(rows[0])
    .filter(key => key !== dateColumn)
    .filter(key => rows.filter(r => looksNumeric(r[key])).length >= Math.max(2, Math.floor(rows.length / 4)))
  const byDay = new Map()
  for (const row of rows) {
    const day = dayOf(row[dateColumn])
    if (day === null) continue
    const bucket = byDay.get(day) ?? Object.fromEntries(numeric.map(k => [k, 0]))
    for (const key of numeric) bucket[key] += toNumber(row[key])
    byDay.set(day, bucket)
  }
  return { dateColumn, columns: numeric, byDay }
}

/** 7-point centred moving average; edges copy the nearest value. */
export function movingAverage(series, window = 7) {
  const out = []
  const half = Math.floor(window / 2)
  for (let i = 0; i < series.length; i++) {
    const from = Math.max(0, i - half)
    const to = Math.min(series.length, i + half + 1)
    const slice = series.slice(from, to)
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length)
  }
  return out
}

/** Least-squares slope of y over its index. */
export function slope(series) {
  const n = series.length
  if (n < 2) return 0
  const meanX = (n - 1) / 2
  const meanY = series.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (series[i] - meanY)
    den += (i - meanX) ** 2
  }
  return den === 0 ? 0 : num / den
}

/**
 * Direction of a series, as a trend judgement rather than a raw sign.
 *
 * A centred moving average needs a window's worth of points, so on a short
 * series it flattens everything and every trend reads "flat". Below eight
 * points the raw series is used; the slope is then judged relative to the
 * series level, so ±0.5% per day is noise and anything above it is a trend.
 *
 * @param {number[]} series
 * @param {number[]} ma centred moving average of `series`
 * @returns {{direction: 'up'|'down'|'flat', strength: string}}
 */
export function directionOf(series, ma = movingAverage(series)) {
  const window = series.length >= 8 ? ma.slice(-7) : series.slice(-14)
  const change = slope(window)
  const level = window.reduce((a, b) => a + b, 0) / Math.max(1, window.length)
  const normalized = level === 0 ? change : change / Math.abs(level)
  const strength = `${(normalized * 100).toFixed(1)}%/day`
  if (normalized > 0.005) return { direction: 'up', strength }
  if (normalized < -0.005) return { direction: 'down', strength }
  return { direction: 'flat', strength }
}

/** Population z-score of the last value against the series before it. */
export function lastZScore(series) {
  if (series.length < 4) return 0
  const history = series.slice(0, -1)
  const mean = history.reduce((a, b) => a + b, 0) / history.length
  const variance = history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length
  const sd = Math.sqrt(variance)
  const last = series[series.length - 1]
  // A dead-flat baseline makes sd zero; a departure from it is the strongest
  // anomaly there is, not a non-event.
  if (sd === 0) return last === mean ? 0 : (last > mean ? 99 : -99)
  return (last - mean) / sd
}

/** Mean absolute week-over-week change across a daily series. */
export function weekOverWeek(byDaySorted, key) {
  const series = byDaySorted.map(entry => entry.value[key] ?? 0)
  if (series.length < 8) return undefined
  const last7 = series.slice(-7)
  const prev7 = series.slice(-14, -7)
  const sum = arr => arr.reduce((a, b) => a + b, 0)
  const prevTotal = sum(prev7)
  if (prevTotal === 0) return undefined
  return (sum(last7) - prevTotal) / prevTotal
}

/**
 * The full trend report for one metric column.
 * @param {Array<Record<string, string>>} rows CSV rows
 * @param {string} metric column name to analyse
 * @param {{metricName?: string}} [opts]
 */
export function trendFor(rows, metric, opts = {}) {
  const { dateColumn, columns, byDay } = aggregateByDay(rows)
  if (dateColumn === '') return { error: 'no date column detected in report rows' }
  const key = columns.find(c => c === metric)
    ?? columns.find(c => c.toLowerCase().includes(String(metric).toLowerCase()))
  if (key === undefined) {
    return { error: `metric "${metric}" not found`, available: columns }
  }
  const days = [...byDay.keys()].sort()
  const series = days.map(d => byDay.get(d)[key] ?? 0)
  const ma = movingAverage(series)
  const { direction, strength } = directionOf(series, ma)
  // Causal anomaly scan: each day is scored against the days before it only,
  // so a spike is not diluted by the very value it should flag.
  const anomalies = []
  for (let i = 3; i < series.length; i++) {
    const z = lastZScore(series.slice(0, i + 1))
    if (Math.abs(z) >= 2.5) anomalies.push({ day: days[i], value: series[i], z })
  }
  const wow = weekOverWeek(days.map(day => ({ value: byDay.get(day) })), key)
  // Compare the last complete 7-day window with the one before it, plus
  // absolute day comparisons for context.
  const last7Total = series.slice(-7).reduce((a, b) => a + b, 0)
  const prev7Total = series.slice(-14, -7).reduce((a, b) => a + b, 0)
  return {
    metric: opts.metricName ?? key,
    dateColumn,
    firstDay: days[0],
    lastDay: days[days.length - 1],
    daysCovered: days.length,
    totalLast7: last7Total,
    totalPrev7: prev7Total,
    wowChange: wow,
    direction,
    directionStrength: strength,
    lastValue: series[series.length - 1],
    peak: { day: days[series.indexOf(Math.max(...series))], value: Math.max(...series) },
    trough: { day: days[series.indexOf(Math.min(...series))], value: Math.min(...series) },
    anomalyDays: anomalies.slice(-5).map(a => ({ day: a.day, value: a.value, z: Number(a.z.toFixed(2)) })),
    sparkline: sparkline(series.slice(-28)),
    dailyAverage: series.reduce((a, b) => a + b, 0) / series.length,
  }
}

/**
 * Summarise every numeric column briefly (used when the caller does not pick
 * a metric): per-column total-last-7, WoW and direction.
 */
export function trendOverview(rows) {
  const { dateColumn, columns, byDay } = aggregateByDay(rows)
  if (dateColumn === '') return { error: 'no date column detected in report rows' }
  const days = [...byDay.keys()].sort()
  const metrics = columns.map(key => {
    const series = days.map(d => byDay.get(d)[key] ?? 0)
    const ma = movingAverage(series)
    return {
      metric: key,
      totalLast7: series.slice(-7).reduce((a, b) => a + b, 0),
      wowChange: weekOverWeek(days.map(day => ({ value: byDay.get(day) })), key),
      direction: directionOf(series, ma).direction,
      sparkline: sparkline(series.slice(-28)),
    }
  })
  return { dateColumn, daysCovered: days.length, range: { first: days[0], last: days[days.length - 1] }, metrics }
}

/** Previous 7-day window boundaries (for `agc_weekly_report` WoW text). */
export function previousWindow(endYmd) {
  return { start: shiftYmd(endYmd, -13), end: shiftYmd(endYmd, -7) }
}
