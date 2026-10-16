/** Every paste shape we have seen from the AGC console. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { detectCredential, documentFor, targetFileFor } from '../src/credential-detect.js'

test('JSON api-client object, pretty printed', () => {
  const detected = detectCredential('{\n  "client_id": "abc12345",\n  "client_secret": "secret98765"\n}')
  assert.equal(detected.kind, 'api-client')
  assert.equal(detected.apiClient.clientId, 'abc12345')
  assert.equal(detected.apiClient.clientSecret, 'secret98765')
  assert.equal(targetFileFor(detected.kind), 'api-client.json')
})

test('JSON api-client with camelCase keys', () => {
  const detected = detectCredential('{"clientId":"id-111111","clientSecret":"sec-222222"}')
  assert.equal(detected.kind, 'api-client')
  assert.equal(detected.apiClient.clientId, 'id-111111')
})

test('JSON wrapped in a code fence and prose', () => {
  const pasted = '这是你的凭据：\n```json\n{"client_id":"id-333333","client_secret":"sec-444444"}\n```\n请妥善保存'
  const detected = detectCredential(pasted)
  assert.equal(detected.kind, 'api-client')
  assert.equal(detected.apiClient.clientSecret, 'sec-444444')
})

test('nested JSON envelope', () => {
  const detected = detectCredential('{"ret":{"code":0},"api_client":{"client_id":"id-555555","client_secret":"sec-666666"}}')
  assert.equal(detected.kind, 'api-client')
  assert.equal(detected.apiClient.clientId, 'id-555555')
})

test('labelled lines in either order', () => {
  const a = detectCredential('client_secret: sec-777777\nclient_id: id-888888')
  assert.equal(a.kind, 'api-client')
  assert.equal(a.apiClient.clientId, 'id-888888')
  const b = detectCredential('Client ID = id-999999\nClient Secret = sec-000000')
  assert.equal(b.kind, 'api-client')
  assert.equal(b.apiClient.clientSecret, 'sec-000000')
})

test('labelled lines with full-width colon and Chinese labels', () => {
  const detected = detectCredential('客户端ID：id-abc123\n客户端密钥：sec-def456')
  assert.equal(detected.kind, 'api-client')
  assert.equal(detected.apiClient.clientId, 'id-abc123')
  assert.equal(detected.apiClient.clientSecret, 'sec-def456')
})

test('values on one line', () => {
  const detected = detectCredential('client_id=id-aaa111, client_secret=sec-bbb222')
  assert.equal(detected.kind, 'api-client')
  assert.equal(detected.apiClient.clientSecret, 'sec-bbb222')
})

test('two bare lines', () => {
  const detected = detectCredential('id-ccc333\nsec-ddd444')
  assert.equal(detected.kind, 'api-client')
  assert.equal(detected.apiClient.clientId, 'id-ccc333')
  assert.ok(detected.notes.some(n => n.includes('没有标签')))
})

test('Service Account JSON as downloaded', () => {
  const file = JSON.stringify({
    key_id: 'kid-123456',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\n',
    sub_account: 'sub-987654',
    token_uri: 'https://oauth-login.cloud.huawei.com/oauth2/v3/token',
  })
  const detected = detectCredential(file)
  assert.equal(detected.kind, 'service-account')
  assert.equal(detected.serviceAccount.key_id, 'kid-123456')
  assert.equal(detected.serviceAccount.sub_account, 'sub-987654')
  assert.ok(detected.serviceAccount.private_key.includes('BEGIN PRIVATE KEY'))
  assert.equal(targetFileFor(detected.kind), 'service-account.json')
  const document = documentFor(detected)
  assert.equal(document.token_uri, 'https://oauth-login.cloud.huawei.com/oauth2/v3/token')
})

test('Service Account JSON with literal backslash-n in the key', () => {
  const detected = detectCredential('{"key_id":"kid-a","private_key":"-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----","sub_account":"sub-a"}')
  assert.equal(detected.kind, 'service-account')
  assert.ok(detected.serviceAccount.private_key.includes('BEGIN PRIVATE KEY'))
})

test('garbage is refused with guidance, never guessed', () => {
  const detected = detectCredential('今天天气不错')
  assert.equal(detected.kind, null)
  assert.ok(detected.problems[0].includes('认不出'))
})

test('empty paste is reported', () => {
  const detected = detectCredential('   \n  ')
  assert.equal(detected.kind, null)
  assert.ok(detected.problems[0].includes('没有粘贴'))
})

test('a single loose value asks for its pair', () => {
  const detected = detectCredential('id-eeee555')
  assert.equal(detected.kind, null)
  assert.ok(detected.problems[0].includes('只识别到一个值'))
})

test('JSON without the right fields names what it saw', () => {
  const detected = detectCredential('{"foo":"bar","baz":1}')
  assert.equal(detected.kind, null)
  assert.ok(detected.problems[0].includes('foo'))
})

test('documentFor never emits an api-client document for a service account', () => {
  const detected = detectCredential('{"key_id":"k","private_key":"-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----","sub_account":"s"}')
  const document = documentFor(detected)
  assert.equal(document.client_id, undefined)
  assert.deepEqual(Object.keys(document).sort(), ['key_id', 'private_key', 'sub_account', 'token_uri'])
})

test('quoted values are unwrapped', () => {
  const detected = detectCredential('client_id: "id-fff666"\nclient_secret: "sec-ggg777"')
  assert.equal(detected.kind, 'api-client')
  assert.equal(detected.apiClient.clientId, 'id-fff666')
  assert.equal(detected.apiClient.clientSecret, 'sec-ggg777')
})
