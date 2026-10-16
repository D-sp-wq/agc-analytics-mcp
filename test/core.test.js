/** Unit tests for the core layer: config, auth, client guards, csv, dates, redaction. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../src/config.js'
import { serviceAccountJwt, AuthProvider } from '../src/auth.js'
import { AgcClient, businessCode } from '../src/client.js'
import { assertAgcHost, isAgcHost, baseUrlFor, SITES } from '../src/sites.js'
import { parseCsv, csvRows, decodeCsv } from '../src/csv.js'
import { ymd, reportRange, toMillis, shiftYmd } from '../src/dates.js'
import { redact, safeMessage } from '../src/redact.js'

// ── config ───────────────────────────────────────────────────────────────────

test('loadConfig reads api client from env', () => {
  const cfg = loadConfig({ AGC_CLIENT_ID: 'id-123', AGC_CLIENT_SECRET: 'sec-456', AGC_SITE: 'sg' })
  assert.equal(cfg.apiClient.clientId, 'id-123')
  assert.equal(cfg.site, 'sg')
  assert.deepEqual(cfg.problems, [])
})

test('loadConfig reads credentials from files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agc-test-'))
  try {
    const clientFile = join(dir, 'client.json')
    writeFileSync(clientFile, JSON.stringify({ client_id: 'cid', client_secret: 'csecret' }))
    const saFile = join(dir, 'sa.json')
    writeFileSync(saFile, JSON.stringify({ key_id: 'kid', private_key: '-----BEGIN PRIVATE KEY-----X', sub_account: 'sub' }))
    const cfg = loadConfig({ AGC_CLIENT_FILE: clientFile, AGC_SERVICE_ACCOUNT_FILE: saFile })
    assert.equal(cfg.apiClient.clientId, 'cid')
    assert.equal(cfg.serviceAccount.keyId, 'kid')
    assert.deepEqual(cfg.problems, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadConfig reports unreadable files as problems, never throws', () => {
  const cfg = loadConfig({ AGC_CLIENT_FILE: join(tmpdir(), 'definitely-missing-9f3.json') })
  assert.equal(cfg.apiClient, null)
  assert.ok(cfg.problems[0].includes('not readable'))
})

// ── auth ─────────────────────────────────────────────────────────────────────

test('service account JWT is well-formed PS256', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwt = serviceAccountJwt({ keyId: 'kid-1', subAccount: 'sub-1', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() })
  const [h, p, s] = jwt.split('.')
  assert.equal(JSON.parse(Buffer.from(h, 'base64url').toString()).alg, 'PS256')
  assert.equal(JSON.parse(Buffer.from(h, 'base64url').toString()).kid, 'kid-1')
  assert.equal(JSON.parse(Buffer.from(p, 'base64url').toString()).iss, 'sub-1')
  assert.ok(s.length > 100)
})

test('AuthProvider issues and caches client token per site', async t => {
  const requests = []
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ access_token: 'tok-abc', expires_in: 172800 }), { status: 200 })
  }
  const config = loadConfig({ AGC_CLIENT_ID: 'id', AGC_CLIENT_SECRET: 'secret' })
  const auth = new AuthProvider(config)
  const first = await auth.headers('https://connect-api.cloud.huawei.com')
  const second = await auth.headers('https://connect-api.cloud.huawei.com')
  assert.equal(first.headers.Authorization, 'Bearer tok-abc')
  assert.equal(second.headers.Authorization, 'Bearer tok-abc')
  assert.equal(requests.length, 1, 'token should be cached')
  assert.equal(requests[0].body.grant_type, 'client_credentials')
  assert.equal(first.headers.client_id, 'id')
})

// ── sites ────────────────────────────────────────────────────────────────────

test('site guard allows AGC hosts and refuses everything else', () => {
  for (const host of Object.values(SITES)) {
    assert.equal(isAgcHost(host), true)
    assert.equal(assertAgcHost(`https://${host}/api/x`).hostname, host)
  }
  assert.equal(isAgcHost('evil.example.com'), false)
  assert.throws(() => assertAgcHost('https://evil.example.com/api/x'), /non-AGC/)
  assert.throws(() => assertAgcHost('http://connect-api.cloud.huawei.com/api/x'), /non-AGC/)
  assert.throws(() => baseUrlFor('mars'), /unknown site/)
})

// ── business codes ───────────────────────────────────────────────────────────

test('businessCode extracts ret / rtnCode / error.errorCode', () => {
  assert.deepEqual(businessCode({ ret: { code: 0, msg: 'ok' } }), { code: 0, msg: 'ok' })
  assert.deepEqual(businessCode({ ret: '{"code":204144647,"msg":"no auth"}' }), { code: 204144647, msg: 'no auth' })
  assert.deepEqual(businessCode({ rtnCode: '80000000', rtnDesc: 'fail' }), { code: 80000000, msg: 'fail' })
  assert.deepEqual(businessCode({ error: { errorCode: 0, errorMsg: 'success' } }), { code: 0, msg: 'success' })
  assert.equal(businessCode({ hello: 1 }), undefined)
})

// ── csv ──────────────────────────────────────────────────────────────────────

test('csv parses quotes, commas, BOM and empty lines', () => {
  const text = '\uFEFF日期,活跃用户,备注\n2026-01-02,"1,234","含,逗号"\n\n2026-01-03,88,ok\n'
  const { header, rows } = csvRows(text)
  assert.deepEqual(header, ['日期', '活跃用户', '备注'])
  assert.equal(rows.length, 2)
  assert.equal(rows[0]['活跃用户'], '1,234')
  assert.equal(rows[0]['备注'], '含,逗号')
  assert.equal(rows[1]['日期'], '2026-01-03')
})

test('csv handles doubled quotes and semicolon delimiters', () => {
  assert.deepEqual(parseCsv('a;b\n"he said ""hi""";2\n')[1], ['he said "hi"', '2'])
})

test('decodeCsv falls back to gbk for mojibake', () => {
  const iconv = Buffer.from([0xD3, 0xC3, 0xBB, 0xA7]) // 用户 in GBK
  const text = decodeCsv(iconv)
  assert.equal(text, '用户')
})

// ── dates ────────────────────────────────────────────────────────────────────

test('ymd accepts both formats and rejects garbage', () => {
  assert.equal(ymd('2026-01-31'), '20260131')
  assert.equal(ymd('20260131'), '20260131')
  assert.throws(() => ymd('2026-13-01'), /YYYY-MM-DD/)
  assert.throws(() => ymd('not-a-date'), /YYYY-MM-DD/)
})

test('reportRange enforces order and the 180-day cap', () => {
  assert.deepEqual(reportRange('2026-01-01', '2026-01-31'), { start: '20260101', end: '20260131' })
  assert.throws(() => reportRange('2026-02-01', '2026-01-01'), /after/)
  assert.throws(() => reportRange('2026-01-01', '2026-12-31'), /180/)
})

test('toMillis endOfDay and shiftYmd', () => {
  const ms = toMillis('2026-03-05', { endOfDay: true })
  assert.equal(new Date(ms).toISOString(), '2026-03-05T23:59:59.999Z')
  assert.equal(shiftYmd('20260301', -1), '20260228')
  assert.equal(shiftYmd('20240301', -1), '20240229')
})

// ── redaction ────────────────────────────────────────────────────────────────

test('redact strips credential shapes from any message', () => {
  const dirty = 'token request failed: {"client_secret":"supersecret1","access_token":"eyJhbGci.lala.sig"} Bearer abcdef123456'
  const clean = redact(dirty)
  assert.ok(!clean.includes('supersecret1'))
  assert.ok(!clean.includes('eyJhbGci'))
  assert.ok(!clean.includes('abcdef123456'))
  assert.ok(safeMessage(new Error('client_secret=leak')).includes('[redacted]'))
})
