/**
 * Crash-metric request/response shaping.
 *
 * The upstream endpoint is `POST /api/apm/api/v1/hap/query/crash/metric`
 * (and `.../app-freeze/metric`). Huawei has not published a fully stable
 * public schema for every filter field, so this module sends a conservative,
 * documented body shape and normalises whatever comes back into flat rows
 * the analytics layer can consume. When the gateway rejects a field the
 * error is surfaced verbatim (redacted) so the caller can adjust via
 * `agc_request`.
 *
 * @module src/analytics/crash.js
 */

/**
 * Build the request body for a crash/app-freeze metric query.
 * @param {{appId: string, startMs: number, endMs: number, dimension?: string, version?: string}} p
 */
export function crashRequestBody(p) {
  const body = {
    appId: p.appId,
    startTime: p.startMs,
    endTime: p.endMs,
    dim: p.dimension === 'version' ? 'version' : p.dimension === 'day' ? 'date' : undefined,
  }
  if (p.version !== undefined && p.version !== '') body.appVersion = p.version
  return JSON.parse(JSON.stringify(body)) // drop undefined
}

/**
 * Normalise a crash-metric response into rows the digest/trend layer reads:
 * { day?, version?, count, users?, rate? }. Unknown shapes pass through with
 * a note so the caller still sees the raw payload.
 * @param {unknown} data
 */
export function normalizeCrashRows(data) {
  const root = /** @type {any} */ (data)
  const payload = root?.value ?? root?.data ?? root?.result ?? root
  const list = Array.isArray(payload) ? payload
    : Array.isArray(payload?.list) ? payload.list
      : Array.isArray(payload?.rows) ? payload.rows
        : Array.isArray(payload?.metrics) ? payload.metrics
          : undefined
  if (list === undefined) {
    return { rows: [], passthrough: data }
  }
  const rows = list
    .map(entry => {
      const e = /** @type {any} */ (entry)
      const count = Number(e.count ?? e.crashCount ?? e.times ?? e.cnt ?? 0)
      const users = Number(e.users ?? e.userCount ?? e.affectedUsers ?? e.affected ?? 0)
      const rate = Number(e.rate ?? e.crashRate ?? e.ratio ?? NaN)
      return {
        day: typeof e.date === 'string' ? e.date : typeof e.day === 'string' ? e.day : undefined,
        version: typeof e.version === 'string' ? e.version : typeof e.appVersion === 'string' ? e.appVersion : undefined,
        count,
        users: Number.isFinite(users) ? users : undefined,
        rate: Number.isFinite(rate) ? rate : undefined,
      }
    })
    .filter(row => Number.isFinite(row.count))
  return { rows }
}

/**
 * Crash summary: totals, by-day trend, by-version ranking, WoW delta.
 * @param {Array<{day?: string, version?: string, count: number, users?: number, rate?: number}>} rows
 */
export function summarizeCrash(rows) {
  const total = rows.reduce((a, r) => a + r.count, 0)
  const byDay = new Map()
  const byVersion = new Map()
  for (const row of rows) {
    if (row.day !== undefined) byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.count)
    if (row.version !== undefined) byVersion.set(row.version, (byVersion.get(row.version) ?? 0) + row.count)
  }
  const days = [...byDay.keys()].sort()
  const series = days.map(d => byDay.get(d))
  const last7 = series.slice(-7).reduce((a, b) => a + b, 0)
  const prev7 = series.slice(-14, -7).reduce((a, b) => a + b, 0)
  return {
    total,
    daysCovered: days.length,
    range: days.length !== 0 ? { first: days[0], last: days[days.length - 1] } : undefined,
    last7Total: last7,
    prev7Total: prev7,
    wowChange: prev7 !== 0 ? (last7 - prev7) / prev7 : undefined,
    worstDays: [...byDay.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([day, count]) => ({ day, count })),
    byVersion: [...byVersion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([version, count]) => ({ version, count })),
    dailySeries: days.map((day, i) => ({ day, count: series[i] })),
  }
}
