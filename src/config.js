/**
 * Credential loading.
 *
 * Two AGC credential kinds are supported, mirroring what the AGC console can
 * mint under「用户与访问 → API 密钥 → Connect API」:
 *
 * - API client  — client_id + client_secret, `client_credentials` grant. Works
 *   for reports, projects, crash metrics and reviews.
 * - Service Account — a JSON file with key_id / private_key / sub_account;
 *   authenticated by a short-lived PS256 JWT. Works for everything except the
 *   review endpoints.
 *
 * Credentials are read once into memory and never written anywhere. The file
 * path is remembered only to describe the configuration back to the user.
 *
 * @module src/config.js
 */

import fs from 'node:fs'

export class ConfigError extends Error {}

function readJsonFile(file, what) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new ConfigError(`${what} file "${file}" is not readable: ${error?.code ?? error?.message ?? error}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new ConfigError(`${what} file "${file}" is not valid JSON`)
  }
}

/**
 * Load credentials from the environment.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   apiClient: {clientId: string, clientSecret: string, source: string} | null,
 *   serviceAccount: {keyId: string, privateKey: string, subAccount: string, source: string} | null,
 *   site: string,
 *   timeoutMs: number,
 *   problems: string[]
 * }}
 */
export function loadConfig(env = process.env) {
  const problems = []
  let apiClient = null
  let serviceAccount = null

  const clientFile = env.AGC_CLIENT_FILE
  if (typeof clientFile === 'string' && clientFile !== '') {
    try {
      const json = readJsonFile(clientFile, 'AGC_CLIENT_FILE')
      const clientId = json?.client_id ?? json?.clientId
      const clientSecret = json?.client_secret ?? json?.clientSecret
      if (typeof clientId !== 'string' || clientId === '' || typeof clientSecret !== 'string' || clientSecret === '') {
        throw new ConfigError('AGC_CLIENT_FILE JSON needs string fields "client_id" and "client_secret"')
      }
      apiClient = { clientId, clientSecret, source: clientFile }
    } catch (error) {
      problems.push(error instanceof ConfigError ? error.message : `AGC_CLIENT_FILE could not be used: ${error?.message ?? error}`)
    }
  } else if (typeof env.AGC_CLIENT_ID === 'string' && env.AGC_CLIENT_ID !== '' && typeof env.AGC_CLIENT_SECRET === 'string' && env.AGC_CLIENT_SECRET !== '') {
    apiClient = { clientId: env.AGC_CLIENT_ID, clientSecret: env.AGC_CLIENT_SECRET, source: 'AGC_CLIENT_ID/AGC_CLIENT_SECRET' }
  }

  const saFile = env.AGC_SERVICE_ACCOUNT_FILE
  if (typeof saFile === 'string' && saFile !== '') {
    try {
      const json = readJsonFile(saFile, 'AGC_SERVICE_ACCOUNT_FILE')
      const keyId = json?.key_id
      const privateKey = json?.private_key
      const subAccount = json?.sub_account
      if (typeof keyId !== 'string' || keyId === '' || typeof privateKey !== 'string' || privateKey === '' || typeof subAccount !== 'string' || subAccount === '') {
        throw new ConfigError('AGC_SERVICE_ACCOUNT_FILE JSON needs string fields "key_id", "private_key" and "sub_account"')
      }
      serviceAccount = { keyId, privateKey, subAccount, source: saFile }
    } catch (error) {
      problems.push(error instanceof ConfigError ? error.message : `AGC_SERVICE_ACCOUNT_FILE could not be used: ${error?.message ?? error}`)
    }
  }

  const site = ['cn', 'de', 'sg', 'ru'].includes(String(env.AGC_SITE ?? 'cn').toLowerCase())
    ? String(env.AGC_SITE ?? 'cn').toLowerCase()
    : 'cn'
  const timeoutMs = Number(env.AGC_TIMEOUT_MS ?? 30_000)
  const baseUrl = resolveBaseUrl(env.AGC_BASE_URL, site, problems)

  return {
    apiClient,
    serviceAccount,
    site,
    baseUrl,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : 30_000,
    problems,
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Resolve the API base URL. `AGC_BASE_URL` exists for two legitimate uses:
 * a corporate gateway in front of AGC, and local integration testing against a
 * mock. It is therefore validated hard — HTTPS is mandatory except for a
 * loopback address, which cannot reach a third party at all.
 */
function resolveBaseUrl(raw, site, problems) {
  const fallback = `https://${SITE_HOSTS[site]}`
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  let parsed
  try {
    parsed = new URL(raw.trim())
  } catch {
    problems.push(`AGC_BASE_URL is not a valid URL: ${raw}`)
    return fallback
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    problems.push(`AGC_BASE_URL must use https (http is allowed only for a loopback mock): ${raw}`)
    return fallback
  }
  return parsed.origin
}

/**
 * Is this base URL a loopback (local mock) endpoint? Used by the client to
 * decide whether an http report URL may be followed.
 * @param {string} baseUrl
 */
export function isLoopbackBase(baseUrl) {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** Site host table, duplicated here to keep config free of circular imports. */
const SITE_HOSTS = Object.freeze({
  cn: 'connect-api.cloud.huawei.com',
  de: 'connect-api-dre.cloud.huawei.com',
  sg: 'connect-api-dra.cloud.huawei.com',
  ru: 'connect-api-drru.cloud.huawei.com',
})
