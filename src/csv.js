/**
 * A tiny CSV reader that covers what AGC report files actually contain:
 * RFC 4180 quoting, commas and newlines inside quotes, a BOM, empty trailing
 * lines, semicolon variants, and GBK-encoded Chinese exports.
 *
 * @module src/csv.js
 */

import { Buffer } from 'node:buffer'

/**
 * Decode report bytes to text. AGC exports are UTF-8 or (for some zh-CN
 * Excel-flavoured exports) GBK; Node's full-icu build decodes both.
 *
 * UTF-8 is attempted strictly first: bytes that are not valid UTF-8 can only
 * come from a legacy encoding, which is exactly the GBK case. If the runtime
 * has no GBK decoder the lossy UTF-8 text is returned rather than failing the
 * whole export.
 * @param {Buffer} bytes
 */
export function decodeCsv(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes).replace(/^\uFEFF/, '')
    } catch {
      return bytes.toString('utf8').replace(/^\uFEFF/, '')
    }
  }
}

/**
 * Parse CSV text into an array of row arrays. Delimiter auto-detected between
 * comma and semicolon per the header line.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const firstLine = text.slice(0, text.search(/\r?\n/) + 1 || text.length)
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(field); field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length !== 1 || row[0] !== '') rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length !== 0) {
    row.push(field)
    if (row.length !== 1 || row[0] !== '') rows.push(row)
  }
  return rows
}

/**
 * Parse CSV into objects keyed by the header row. Duplicate headers get a
 * numeric suffix so no column is silently lost.
 * @param {string} text
 * @returns {{header: string[], rows: Array<Record<string, string>>}}
 */
export function csvRows(text) {
  const all = parseCsv(text)
  if (all.length === 0) return { header: [], rows: [] }
  const header = all[0].map((h, i) => {
    const name = h.trim()
    return name === '' ? `col${i}` : name
  })
  const seen = new Map()
  const unique = header.map(name => {
    const n = seen.get(name) ?? 0
    seen.set(name, n + 1)
    return n === 0 ? name : `${name}.${n}`
  })
  const rows = all.slice(1).map(cells => {
    const record = {}
    unique.forEach((name, i) => { record[name] = (cells[i] ?? '').trim() })
    return record
  })
  return { header: unique, rows }
}
