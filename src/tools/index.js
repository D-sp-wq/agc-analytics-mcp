/**
 * The tool registry — every tool this server exposes, in list order.
 *
 * @module src/tools/index.js
 */

import { systemTools } from './system.js'
import { appTools } from './apps.js'
import { reportTools } from './reports.js'
import { crashTools } from './crash.js'
import { reviewTools } from './reviews.js'
import { digestTools } from './digest.js'
import { requestTool } from './request.js'

/**
 * @param {{config: unknown, auth: unknown, client: unknown}} deps
 */
export function buildRegistry(deps) {
  const tools = [
    ...systemTools(deps),
    ...appTools(deps),
    ...reportTools(deps),
    ...crashTools(deps),
    ...reviewTools(deps),
    ...digestTools(deps),
    ...requestTool(deps),
  ]
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  return {
    list: () => tools,
    get: name => byName.get(name),
  }
}
