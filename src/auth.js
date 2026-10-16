/**
 * Token issuance and caching.
 *
 * - API client: one `client_credentials` POST per site; the access token is
 *   cached per base URL and refreshed five minutes before it expires.
 * - Service Account: a PS256-signed JWT minted on demand (and minted again
 *   every hour); no network round trip is involved.
 *
 * Tokens live in memory only.
 *
 * @module src/auth.js
 */

import { createPrivateKey, sign } from 'node:crypto'
import { baseUrlFor } from './sites.js'

const JWT_AUD = 'https://oauth-login.cloud.huawei.com/oauth2/v3/token'
const JWT_TTL_MS = 60 * 60 * 1000
const REFRESH_MARGIN_MS = 5 * 60 * 1000
const DEFAULT_TOKEN_TTL_MS = 48 * 60 * 60 * 1000 // AGC client tokens usually live 48h

const b64url = input => Buffer.from(input).toString('base64url')

/** Build a Service Account assertion JWT (PS256). Exported for tests. */
export function serviceAccountJwt(account, nowMs = Date.now()) {
  const header = { kid: account.keyId, typ: 'JWT', alg: 'PS256' }
  const payload = { aud: JWT_AUD, iss: account.subAccount, iat: Math.floor(nowMs / 1000), exp: Math.floor((nowMs + JWT_TTL_MS) / 1000) }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  let pem = account.privateKey
  if (!pem.includes('-----BEGIN')) pem = `-----BEGIN PRIVATE KEY-----\n${pem.trim()}\n-----END PRIVATE KEY-----\n`
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(pem),
    padding: 1, // RSA_PKCS1_PSS_PADDING
    saltLength: 32,
  })
  return `${signingInput}.${b64url(signature)}`
}

export class AuthProvider {
  #cache = new Map()

  constructor(config) {
    this.config = config
  }

  describe() {
    const parts = []
    if (this.config.serviceAccount !== null) parts.push(`service account (sub_account=${this.config.serviceAccount.subAccount})`)
    if (this.config.apiClient !== null) parts.push(`api client (client_id=${this.config.apiClient.clientId})`)
    return parts.length !== 0 ? parts.join(' + ') : 'none configured'
  }

  /** Credential kinds available after loading. */
  modes() {
    const modes = []
    if (this.config.serviceAccount !== null) modes.push('service_account')
    if (this.config.apiClient !== null) modes.push('api_client')
    return modes
  }

  /**
   * Authorization headers for a request to `base`.
   * @param {string} base site base URL
   * @param {{preferred?: string[], forceRefresh?: boolean}} [opts]
   * @returns {Promise<{mode: string, headers: Record<string, string>}>}
   */
  async headers(base, opts = {}) {
    const available = this.modes()
    if (available.length === 0) {
      const problems = this.config.problems.length !== 0 ? ` Problems: ${this.config.problems.join(' ')}` : ''
      throw new Error(
        'No AGC credentials configured. Set AGC_CLIENT_FILE (JSON with client_id/client_secret), '
        + 'or AGC_CLIENT_ID + AGC_CLIENT_SECRET, and/or AGC_SERVICE_ACCOUNT_FILE.'
        + problems,
      )
    }
    const mode = opts.preferred?.find(m => available.includes(m)) ?? available[0]
    const key = mode === 'service_account' ? 'sa' : base
    let cached = this.#cache.get(key)
    if (opts.forceRefresh !== true || cached === undefined) {
      if (cached === undefined || cached.expiresAt - REFRESH_MARGIN_MS < Date.now()) {
        cached = mode === 'service_account' ? this.#issueJwt() : await this.#clientToken(base)
        this.#cache.set(key, cached)
      }
    }
    const headers = { Authorization: `Bearer ${cached.value}` }
    if (mode === 'api_client') headers.client_id = this.config.apiClient.clientId
    return { mode, headers }
  }

  #issueJwt() {
    return { value: serviceAccountJwt(this.config.serviceAccount), expiresAt: Date.now() + JWT_TTL_MS }
  }

  async #clientToken(base) {
    const { clientId, clientSecret } = this.config.apiClient
    const response = await fetch(`${base}/api/oauth2/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    })
    const text = await response.text()
    let json = {}
    try { json = JSON.parse(text) } catch { /* handled below as a failure */ }
    if (!response.ok || typeof json.access_token !== 'string' || json.access_token === '') {
      // `text` is the upstream error body; it is redacted by the caller's
      // error path and contains no credential we sent.
      throw new Error(`AGC token request failed (HTTP ${response.status}): ${text.slice(0, 300)}`)
    }
    const ttl = Number(json.expires_in)
    const expiresAt = Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TOKEN_TTL_MS / 1000) * 1000
    return { value: json.access_token, expiresAt }
  }

  /** Forget cached tokens (used by tests and after an auth outage). */
  clear() {
    this.#cache.clear()
  }
}

export { baseUrlFor }
