/**
 * The AGC HTTP client.
 *
 * Responsibilities, in order of importance:
 * 1. Never send credentials anywhere but the four AGC site hosts (`assertAgcHost`).
 * 2. Surface AGC business errors (ret.code / rtnCode / error.errorCode) as
 *    regular Errors with fixable messages, redacted before they escape.
 * 3. One transparent retry on HTTP 401 with a forced token refresh.
 *
 * @module src/client.js
 */

import { baseUrlFor, assertAgcHost, isAgcHost } from './sites.js'
import { isLoopbackBase } from './config.js'
import { safeMessage } from './redact.js'

/** Extract the AGC business return code from the many response shapes. */
export function businessCode(data) {
  if (data === null || typeof data !== 'object') return undefined
  const d = /** @type {Record<string, unknown>} */ (data)
  let ret = d.ret ?? d.et
  if (typeof ret === 'string') {
    try { ret = JSON.parse(ret) } catch { return undefined }
  }
  if (ret !== null && typeof ret === 'object' && 'code' in ret) {
    return { code: Number(ret.code), msg: typeof ret.msg === 'string' ? ret.msg : undefined }
  }
  if ('rtnCode' in d) return { code: Number(d.rtnCode), msg: typeof d.rtnDesc === 'string' ? d.rtnDesc : undefined }
  const err = d.error
  if (err !== null && typeof err === 'object' && 'errorCode' in err) {
    return { code: Number(err.errorCode), msg: typeof err.errorMsg === 'string' ? err.errorMsg : undefined }
  }
  return undefined
}

export class AgcError extends Error {
  constructor(message, { status = 0, business = undefined } = {}) {
    super(message)
    this.name = 'AgcError'
    this.status = status
    this.business = business
  }
}

export class AgcClient {
  constructor(config, auth) {
    this.config = config
    this.auth = auth
    /** True when AGC_BASE_URL points at a local mock (integration tests). */
    this.loopback = isLoopbackBase(config.baseUrl)
  }

  /**
   * Base URL for a call. An explicit per-call `site` always resolves through
   * the AGC site table; otherwise the configured base URL wins (which is the
   * site URL unless AGC_BASE_URL overrode it).
   * @param {string} [site]
   */
  baseFor(site) {
    if (site !== undefined && site !== this.config.site) return baseUrlFor(site)
    return this.config.baseUrl ?? baseUrlFor(this.config.site)
  }

  /**
   * Call a Connect API endpoint. JSON is parsed when possible.
   * @param {string} method HTTP verb
   * @param {string} path API path beginning with /api/
   * @param {{query?: Record<string, string|number|boolean|undefined|(string|number)[]>, body?: unknown, site?: string, preferred?: string[]}} [opts]
   * @returns {Promise<{status: number, data: unknown, mode: string}>}
   */
  async request(method, path, opts = {}) {
    const base = this.baseFor(opts.site)
    const url = new URL(path.startsWith('/') ? path : `/${path}`, base)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      if (Array.isArray(value)) value.forEach(v => url.searchParams.append(key, String(v)))
      else url.searchParams.set(key, String(value))
    }
    // A loopback base URL (explicit AGC_BASE_URL mock) is the one exception to
    // the AGC-host rule; everything else must be a real Huawei endpoint.
    if (!this.loopback) assertAgcHost(url)

    const send = async force => {
      const { mode, headers } = await this.auth.headers(base, { preferred: opts.preferred, forceRefresh: force })
      const init = {
        method,
        headers: { Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      }
      if (opts.body !== undefined && method !== 'GET') {
        headers['Content-Type'] = 'application/json; charset=utf-8'
        init.body = JSON.stringify(opts.body)
      }
      const response = await fetch(url, init)
      return { response, mode }
    }

    let { response, mode } = await send(false)
    if (response.status === 401) ({ response, mode } = await send(true))
    const text = await response.text()
    let data = text
    try { data = text === '' ? null : JSON.parse(text) } catch { /* keep raw text */ }
    return { status: response.status, data, mode }
  }

  /**
   * `request` plus AGC business-code checking: HTTP >= 400 or a non-zero
   * business code throws `AgcError` with a redacted, actionable message.
   */
  async call(method, path, opts = {}) {
    let result
    try {
      result = await this.request(method, path, opts)
    } catch (error) {
      throw new AgcError(safeMessage(error))
    }
    const biz = businessCode(result.data)
    if (result.status >= 400 || (biz !== undefined && biz.code !== 0)) {
      const detail = biz !== undefined
        ? `code=${biz.code}${biz.msg !== undefined ? ` msg=${safeMessage(biz.msg, 300)}` : ''}`
        : safeMessage(typeof result.data === 'string' ? result.data : JSON.stringify(result.data), 300)
      throw new AgcError(`AGC ${method} ${path} failed (HTTP ${result.status}): ${detail}`, { status: result.status, business: biz })
    }
    return result
  }

  /**
   * Download a report file (the short-lived signed `fileURL` the report
   * endpoints hand out). Credentials are deliberately NOT attached — the URL
   * is pre-signed — and the host must still be a Huawei domain over https.
   * @param {string} fileUrl
   * @param {number} [maxBytes=200_000_000]
   * @returns {Promise<{bytes: Buffer, contentType: string}>}
   */
  async download(fileUrl, maxBytes = 200_000_000) {
    const url = new URL(fileUrl)
    const loopbackMock = this.loopback && LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackMock)) {
      throw new AgcError(`refusing non-https report download: ${url.protocol}`)
    }
    if (!loopbackMock && !isAgcHost(url.hostname) && !url.hostname.endsWith('.huawei.com') && !url.hostname.endsWith('.myhuaweicloud.com')) {
      throw new AgcError(`refusing report download to unexpected host: ${url.hostname}`)
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(this.config.timeoutMs) })
    if (!response.ok) throw new AgcError(`report download failed (HTTP ${response.status})`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) throw new AgcError(`report file is ${buffer.length} bytes, over the ${maxBytes} safety cap`)
    return { bytes: buffer, contentType: response.headers.get('content-type') ?? '' }
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
