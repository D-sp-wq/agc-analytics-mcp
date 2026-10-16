/**
 * System tools: auth/config status. No network calls.
 *
 * @module src/tools/system.js
 */

import { baseUrlFor } from '../sites.js'

/**
 * @param {{config: import('../config.js').ReturnType<typeof import('../config.js').loadConfig>}} deps
 */
export function systemTools({ config }) {
  return [
    {
      name: 'agc_auth_status',
      title: 'Check AGC credential configuration',
      description:
        'Report the AGC credential configuration: which credential kinds are loaded (API client / Service Account), '
        + 'the active site, timeout, and any configuration problems. No network request is made. '
        + 'Call this first when requests start failing with auth errors. Secrets are never included.',
      network: false,
      inputSchema: { type: 'object', properties: {} },
      parse: args => args ?? {},
      run: async () => ({
        credentialsLoaded: {
          apiClient: config.apiClient !== null,
          serviceAccount: config.serviceAccount !== null,
        },
        sources: {
          apiClient: config.apiClient?.source,
          serviceAccount: config.serviceAccount?.source,
        },
        site: config.site,
        baseUrl: baseUrlFor(config.site),
        timeoutMs: config.timeoutMs,
        problems: config.problems,
        hints: config.apiClient === null && config.serviceAccount === null
          ? ['Set AGC_CLIENT_FILE (JSON with client_id and client_secret) or AGC_CLIENT_ID + AGC_CLIENT_SECRET.']
          : config.serviceAccount === null
            ? ['Reviews/ratings endpoints require the API client credential; Service Account alone cannot call them.']
            : [],
      }),
    },
  ]
}
