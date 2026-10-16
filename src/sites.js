/**
 * The four AGC sites and the only hosts this plugin will ever send
 * credentials to.
 *
 * Every outbound request passes `assertAgcHost` below — a URL whose hostname
 * is not in this table is refused before a single byte of auth material is
 * attached. Report file downloads additionally go through `isAgcHost` so a
 * signed OBS/file URL pointing anywhere else is refused too.
 *
 * @module src/sites.js
 */

export const SITES = Object.freeze({
  cn: 'connect-api.cloud.huawei.com',
  de: 'connect-api-dre.cloud.huawei.com',
  sg: 'connect-api-dra.cloud.huawei.com',
  ru: 'connect-api-drru.cloud.huawei.com',
})

export const DEFAULT_SITE = 'cn'

/** `true` only for an exact AGC site host over https. */
export function isAgcHost(hostname) {
  return Object.values(SITES).includes(String(hostname).toLowerCase())
}

/**
 * Refuse anything that is not one of the four AGC API hosts over https.
 * This is the last line of defense before credentials leave the process.
 * @param {string | URL} url
 * @returns {URL} the same URL, for call chaining
 */
export function assertAgcHost(url) {
  const parsed = url instanceof URL ? url : new URL(String(url))
  if (parsed.protocol !== 'https:' || !isAgcHost(parsed.hostname)) {
    throw new Error(`refusing to send credentials to non-AGC endpoint: ${parsed.origin}`)
  }
  return parsed
}

/** Site name → base URL, or throw on an unknown name. */
export function baseUrlFor(site) {
  const host = SITES[String(site || DEFAULT_SITE).toLowerCase()]
  if (host === undefined) {
    throw new Error(`unknown site "${site}"; valid sites: ${Object.keys(SITES).join(', ')}`)
  }
  return `https://${host}`
}
