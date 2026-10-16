/**
 * Formatting helpers for tool output.
 *
 * @module src/format.js
 */

/** A compact human number: thousands separators, up to 2 decimals. */
export function num(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v ?? '—')
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** Percentage with sign, one decimal. */
export function pct(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`
}

/** Ratio (0–1 or 0–100 auto) as percent text. */
export function ratio(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  const scaled = Math.abs(n) <= 1 ? n * 100 : n
  return `${scaled.toFixed(2)}%`
}

/** Trend arrow for a delta. */
export function arrow(delta) {
  const n = Number(delta)
  if (!Number.isFinite(n) || n === 0) return '→'
  return n > 0 ? '↑' : '↓'
}

/** Render a column of numbers as a Unicode sparkline (▁▂▃▄▅▆▇█). */
export function sparkline(values) {
  const nums = values.map(Number).filter(Number.isFinite)
  if (nums.length < 2) return ''
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const span = max - min
  const blocks = '▁▂▃▄▅▆▇█'
  if (span === 0) return blocks[2].repeat(nums.length)
  return nums.map(v => blocks[Math.min(7, Math.floor(((v - min) / span) * 7.999))]).join('')
}
