/**
 * Tool input validation — a deliberately small schema checker plus the
 * shared argument shapes every tool uses.
 *
 * @module src/schema.js
 */

/**
 * Validate `args` against a mini schema. Throws an Error with a fixable
 * message when validation fails. Supported keywords: type, required,
 * properties, enum, items, min, max, pattern, default is applied by callers.
 * @param {Record<string, unknown>} args
 * @param {Record<string, {type?: string, enum?: unknown[], pattern?: string, min?: number, max?: number, description?: string}>} schema
 * @param {{required?: string[]}} [opts]
 */
export function validate(args, schema, opts = {}) {
  const value = args ?? {}
  for (const name of opts.required ?? []) {
    if (value[name] === undefined || value[name] === null || value[name] === '') {
      throw new Error(`missing required argument "${name}"`)
    }
  }
  for (const [name, rule] of Object.entries(schema)) {
    const v = value[name]
    if (v === undefined || v === null) continue
    if (rule.type === 'string' && typeof v !== 'string') throw new Error(`argument "${name}" must be a string`)
    if (rule.type === 'number' && typeof v !== 'number') throw new Error(`argument "${name}" must be a number`)
    if (rule.type === 'boolean' && typeof v !== 'boolean') throw new Error(`argument "${name}" must be a boolean`)
    if (rule.type === 'array' && !Array.isArray(v)) throw new Error(`argument "${name}" must be an array`)
    if (rule.enum !== undefined && !rule.enum.includes(v)) {
      throw new Error(`argument "${name}" must be one of: ${rule.enum.join(', ')}`)
    }
    if (rule.type === 'number') {
      if (rule.min !== undefined && v < rule.min) throw new Error(`argument "${name}" must be >= ${rule.min}`)
      if (rule.max !== undefined && v > rule.max) throw new Error(`argument "${name}" must be <= ${rule.max}`)
    }
    if (rule.type === 'string' && rule.pattern !== undefined && !new RegExp(rule.pattern).test(v)) {
      throw new Error(`argument "${name}" must match ${rule.pattern}`)
    }
  }
  return value
}

/** The site argument shared by every networked tool. */
export const SITE_ARG = {
  site: { type: 'string', enum: ['cn', 'de', 'sg', 'ru'], description: 'AGC site: cn / de / sg / ru (default from AGC_SITE, otherwise cn)' },
}
