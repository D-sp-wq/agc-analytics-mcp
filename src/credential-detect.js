/**
 * Work out what someone just pasted from the AGC console.
 *
 * People copy whatever the console shows them: a JSON blob, a couple of
 * "client_id: …" lines, a Service Account file's contents, or just two values
 * on two lines. Rather than asking them to reshape it, this module recognises
 * the shapes and says what it found — plus what it had to assume.
 *
 * Pure function, no I/O, so the paste dialog can call it and the test suite can
 * cover every format we have seen.
 *
 * @module src/credential-detect.js
 */

/** Labels seen in the console, in both languages. */
const CLIENT_ID_LABEL = /(?:client[\s_-]?id|客户端\s*id|应用\s*id|api\s*key\s*id|access[\s_-]?key)/i
const CLIENT_SECRET_LABEL = /(?:client[\s_-]?secret|客户端\s*密钥|应用\s*密钥|密钥|secret|access[\s_-]?secret)/i
const KEY_ID_LABEL = /(?:key[\s_-]?id|密钥\s*id)/i
const SUB_ACCOUNT_LABEL = /(?:sub[\s_-]?account|子账号|帐号|账号)/i

const stripWrapper = value => String(value ?? '')
  .trim()
  .replace(/^[`"'“”‘’]+/, '')
  .replace(/[`"'“”‘’]+$/, '')
  .replace(/[,;，；]+$/, '')
  .trim()

/**
 * Credential values are single ASCII tokens (Huawei ids/secrets never contain
 * spaces or CJK), which is also what keeps unrelated prose from being read as a
 * credential.
 */
const looksLikeKey = value => typeof value === 'string' && /^[\x21-\x7E]{6,}$/.test(value.trim())

/** Read `label: value` (or `label=value`, `label：value`) out of free text. */
function fieldFromText(text, labelPattern) {
  // The value stops at whitespace, comma or semicolon, so a line carrying both
  // fields ("client_id=a, client_secret=b") yields one value per label.
  const pattern = new RegExp(`${labelPattern.source}\\s*[:=：]\\s*([^\\s,;，；]+)`, 'i')
  const match = pattern.exec(String(text))
  if (match === null) return undefined
  const value = stripWrapper(match[1])
  return value === '' || value.length > 4096 ? undefined : value
}

/** Any JSON object in the text, including one wrapped in prose or code fences. */
function extractJson(text) {
  const trimmed = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const attempts = [trimmed]
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1))
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { /* try the next candidate */ }
  }
  return undefined
}

const asApiClient = object => {
  const clientId = object.client_id ?? object.clientId ?? object.ClientId ?? object.clientID
  const clientSecret = object.client_secret ?? object.clientSecret ?? object.ClientSecret ?? object.secret
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string') return undefined
  return { clientId, clientSecret }
}

const asServiceAccount = object => {
  const keyId = object.key_id ?? object.keyId
  const privateKey = object.private_key ?? object.privateKey
  const subAccount = object.sub_account ?? object.subAccount
  if (typeof keyId !== 'string' || typeof privateKey !== 'string' || typeof subAccount !== 'string') return undefined
  return { key_id: keyId, private_key: privateKey, sub_account: subAccount }
}

/**
 * @param {string} text whatever the user pasted
 * @returns {{
 *   kind: 'api-client'|'service-account'|null,
 *   apiClient?: {clientId: string, clientSecret: string},
 *   serviceAccount?: {key_id: string, private_key: string, sub_account: string},
 *   notes: string[],
 *   problems: string[]
 * }}
 */
export function detectCredential(text) {
  const notes = []
  const problems = []
  const raw = String(text ?? '')
  if (raw.trim() === '') return { kind: null, notes, problems: ['没有粘贴任何内容'] }

  // 1. A JSON object, whole text or embedded.
  const json = extractJson(raw)
  if (json !== undefined) {
    const nested = [json, ...Object.values(json).filter(v => v !== null && typeof v === 'object' && !Array.isArray(v))]
    for (const candidate of nested) {
      const client = asApiClient(candidate)
      if (client !== undefined) {
        notes.push('JSON 里含 client_id / client_secret')
        return { kind: 'api-client', apiClient: client, notes, problems }
      }
      const account = asServiceAccount(candidate)
      if (account !== undefined) {
        notes.push('JSON 里含 key_id / private_key / sub_account')
        return { kind: 'service-account', serviceAccount: account, notes, problems }
      }
    }
    if (Object.keys(json).length !== 0) {
      problems.push(`JSON 里没有 client_id/client_secret，也没有 key_id/private_key/sub_account（字段有：${Object.keys(json).join(', ')}）`)
      return { kind: null, notes, problems }
    }
  }

  // 2. Labelled fields in free text.
  const labelledId = fieldFromText(raw, CLIENT_ID_LABEL)
  const labelledSecret = fieldFromText(raw, CLIENT_SECRET_LABEL)
  if (labelledId !== undefined && labelledSecret !== undefined) {
    notes.push('从 client_id / client_secret 标签行读出')
    return { kind: 'api-client', apiClient: { clientId: labelledId, clientSecret: labelledSecret }, notes, problems }
  }

  const keyId = fieldFromText(raw, KEY_ID_LABEL)
  const subAccount = fieldFromText(raw, SUB_ACCOUNT_LABEL)
  if (keyId !== undefined && subAccount !== undefined && /PRIVATE KEY/.test(raw)) {
    const privateKey = /-----BEGIN[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/.exec(raw)?.[0]
    if (privateKey !== undefined) {
      notes.push('从 key_id / sub_account 与私钥块读出')
      return { kind: 'service-account', serviceAccount: { key_id: keyId, private_key: privateKey, sub_account: subAccount }, notes, problems }
    }
  }

  // 3. Two bare values on two lines: the id on the first, the secret on the second.
  const lines = raw.split(/\r?\n/).map(stripWrapper).filter(line => line !== '')
  if (lines.length === 2 && lines.every(looksLikeKey)) {
    notes.push('没有标签，按"第一行是 client_id、第二行是 client_secret"理解')
    return { kind: 'api-client', apiClient: { clientId: lines[0], clientSecret: lines[1] }, notes, problems }
  }

  // 4. One bare value: it could be a secret pasted without its id.
  if (lines.length === 1 && looksLikeKey(lines[0])) {
    problems.push('只识别到一个值，API 客户端需要 client_id 和 client_secret 两个值（或粘贴整个 JSON / 私钥文件）')
    return { kind: null, notes, problems }
  }

  problems.push('认不出这段内容。可以粘贴：控制台的 JSON、含 client_id/client_secret 的两行、或 Service Account 的 *private.json 全文')
  return { kind: null, notes, problems }
}

/** Where a detected credential should be stored. */
export function targetFileFor(kind) {
  return kind === 'service-account' ? 'service-account.json' : kind === 'api-client' ? 'api-client.json' : null
}

/** The JSON document to write for a detected credential. */
export function documentFor(detected) {
  if (detected.kind === 'api-client') {
    return { client_id: detected.apiClient.clientId, client_secret: detected.apiClient.clientSecret }
  }
  if (detected.kind === 'service-account') {
    return {
      key_id: detected.serviceAccount.key_id,
      private_key: detected.serviceAccount.private_key,
      sub_account: detected.serviceAccount.sub_account,
      token_uri: 'https://oauth-login.cloud.huawei.com/oauth2/v3/token',
    }
  }
  return null
}
