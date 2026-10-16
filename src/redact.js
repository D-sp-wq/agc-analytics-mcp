/**
 * Redaction for anything that might reach a log, a tool result or an error
 * message. Credentials exist in this process only to be sent to Huawei; they
 * must never be echoed back to the model or the user.
 *
 * @module src/redact.js
 */

const SECRET_PATTERNS = [
  /client_secret["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
  /clientSecret["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
  /private_key["']?\s*[:=]\s*["']?[^"',\s}]{8,}/gi,
  /access_token["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
  /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/g,
]

/** Replace any credential-shaped substring with a fixed marker. */
export function redact(text) {
  let out = String(text ?? '')
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  return out
}

/**
 * Redact and truncate a message for the outside world. Every tool error and
 * every diagnostic line goes through this.
 * @param {unknown} error
 * @param {number} [max=600]
 */
export function safeMessage(error, max = 600) {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const cut = raw.length > max ? `${raw.slice(0, max)}…` : raw
  return redact(cut)
}
