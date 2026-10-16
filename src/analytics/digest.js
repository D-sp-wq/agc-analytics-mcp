/**
 * Daily / weekly digest builders.
 *
 * Each section is produced by one fetcher; a failing section degrades to a
 * marked paragraph instead of failing the whole report. The output is
 * Markdown text ready to paste or write to a file.
 *
 * @module src/analytics/digest.js
 */

import { arrow, num, pct, ratio } from '../format.js'

/** One digest section: heading + body or a failure note. */
function section(title, promise) {
  return promise.then(body => ({ title, ok: true, body })).catch(error => ({
    title,
    ok: false,
    body: `> section unavailable: ${error?.message ?? error}`,
  }))
}

/** Format a WoW line when both sides exist. */
function wowLine(label, current, previous) {
  if (current === undefined || previous === undefined || previous === 0) {
    return `| ${label} | ${num(current)} | — |`
  }
  const delta = (current - previous) / previous
  return `| ${label} | ${num(current)} | ${arrow(delta)} ${pct(delta)} vs prev ${num(previous)} |`
}

/**
 * Build the daily report Markdown.
 * @param {{date: string, appName?: string, sections: Array<{title: string, promise: Promise<string|object>}>}} plan
 */
export async function dailyDigest({ date, appName, sections }) {
  const settled = await Promise.all(sections.map(entry => section(entry.title, entry.promise)))
  const lines = []
  lines.push(`# AGC Daily Report — ${date}${appName !== undefined ? ` — ${appName}` : ''}`)
  lines.push('')
  for (const part of settled) {
    lines.push(`## ${part.title}${part.ok ? '' : ' ⚠'}`)
    lines.push('')
    lines.push(typeof part.body === 'string' ? part.body : JSON.stringify(part.body, null, 2))
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Build the weekly report Markdown with WoW comparisons.
 * @param {{endDay: string, appName?: string, sections: {title: string, current: Promise<any>, previous?: Promise<any>;}[]}} plan
 */
export async function weeklyDigest({ endDay, appName, sections }) {
  const lines = []
  lines.push(`# AGC Weekly Report — week ending ${endDay}${appName !== undefined ? ` — ${appName}` : ''}`)
  lines.push('')
  for (const spec of sections) {
    try {
      const current = await spec.current
      const previous = spec.previous === undefined ? undefined : await spec.previous
      lines.push(`## ${spec.title}`)
      lines.push('')
      if (typeof current === 'string') {
        lines.push(current)
      } else {
        lines.push('| metric | this week | trend |')
        lines.push('|---|---|---|')
        for (const row of toRows(current, previous)) lines.push(row)
      }
      // Notes may already be formatted bullets ("- x", "> x"); only prefix the
      // ones that are not.
      for (const note of current?.notes ?? []) {
        lines.push(/^\s*([-*>]|\d+\.)/.test(note) ? note : `- ${note}`)
      }
      lines.push('')
    } catch (error) {
      lines.push(`## ${spec.title} ⚠`)
      lines.push('')
      lines.push(`> section unavailable: ${error?.message ?? error}`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

/** Flatten summary objects into table rows. */
function toRows(current, previous) {
  const rows = []
  const cur = current ?? {}
  const prev = previous ?? {}
  if (cur.totalLast7 !== undefined) {
    rows.push(wowLine('last 7 days total', cur.totalLast7, prev.totalLast7 ?? cur.totalPrev7))
  }
  if (cur.total !== undefined) rows.push(`| all-time total | ${num(cur.total)} | |`)
  if (cur.averageRating !== undefined) rows.push(`| average rating | ${cur.averageRating} | ${prev.averageRating !== undefined ? arrow(cur.averageRating - prev.averageRating) : ''} |`)
  if (cur.daysCovered !== undefined) rows.push(`| days with data | ${num(cur.daysCovered)} | |`)
  if (cur.crashRate !== undefined) rows.push(`| crash rate | ${ratio(cur.crashRate)} | |`)
  for (const anomaly of cur.anomalyDays ?? []) {
    rows.push(`| ⚠ anomaly ${anomaly.day} | ${num(anomaly.value)} | z=${anomaly.z} |`)
  }
  return rows
}
