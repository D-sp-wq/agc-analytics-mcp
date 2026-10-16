/**
 * Account tools: list projects/apps, resolve package names to appIds.
 *
 * @module src/tools/apps.js
 */

import { validate, SITE_ARG } from '../schema.js'

/**
 * @param {{client: import('../client.js').AgcClient}} deps
 */
export function appTools({ client }) {
  return [
    {
      name: 'agc_list_apps',
      title: 'List AGC projects and apps',
      description:
        'List all AGC projects visible to the credential and the apps inside each (appId, name, package name, device types). '
        + 'Use this to discover the appId every other tool requires.',
      inputSchema: {
        type: 'object',
        properties: { ...SITE_ARG },
      },
      parse: args => validate(args, SITE_ARG),
      run: async args => {
        const list = await client.call('GET', '/api/project-service/v1/projects', { query: { pageSize: 100 }, site: args.site })
        const projectIds = (list.data?.projectList ?? []).map(p => p.projectId).filter(Boolean)
        const projects = await Promise.all(projectIds.map(async id => {
          const detail = await client.call('GET', `/api/project-service/v1/projects/${encodeURIComponent(String(id))}`, {
            query: { queryFlag: 1 },
            site: args.site,
          }).catch(error => ({ data: { error: String(error.message) } }))
          const project = detail.data?.project ?? {}
          return {
            projectId: project.projectId ?? id,
            name: project.name,
            apps: (project.appList ?? []).map(a => ({
              appId: a.appId,
              appName: a.appName,
              packageName: a.packageName,
              appType: a.appType,
              deviceTypes: a.deviceTypes,
            })),
            error: detail.data?.error,
          }
        }))
        return { projects }
      },
    },
    {
      name: 'agc_get_app_id',
      title: 'Resolve package name to appId',
      description: 'Resolve AGC appId(s) from package name(s), comma-separated, up to 50.',
      inputSchema: {
        type: 'object',
        properties: {
          packageNames: { type: 'string', description: 'Package names, comma separated, e.g. com.example.app' },
          ...SITE_ARG,
        },
        required: ['packageNames'],
      },
      parse: args => {
        validate(args, { packageNames: { type: 'string' }, ...SITE_ARG }, { required: ['packageNames'] })
        const names = args.packageNames.split(',').map(s => s.trim()).filter(Boolean)
        if (names.length === 0) throw new Error('packageNames must contain at least one package name')
        if (names.length > 50) throw new Error('at most 50 package names per call')
        return { ...args, names: names.join(',') }
      },
      run: async args =>
        (await client.call('GET', '/api/publish/v2/appid-list', { query: { packageName: args.names }, site: args.site })).data,
    },
  ]
}
