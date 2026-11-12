import assert from 'node:assert/strict'
import test from 'node:test'

import { redact } from '../lib/shared/redact.js'

function masked(text, options) {
  return redact(text, options).text
}

test('redact: API keys never survive', () => {
  const text = 'use key sk-abcdefghijklmnopqrstuvwx for this call'
  const out = masked(text)
  assert.ok(!out.includes('sk-abcdefghijklmnopqrstuvwx'))
  assert.ok(out.includes('密钥'))
})

test('redact: env assignment keeps the variable name, masks the value', () => {
  const out = masked('DEEPSEEK_API_KEY=sk-livevalue1234567890 configure it')
  assert.ok(out.includes('DEEPSEEK_API_KEY='))
  assert.ok(!out.includes('sk-livevalue1234567890'))
})

test('redact: JWTs are masked', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
  const out = masked(`Authorization: ${jwt}`)
  assert.ok(!out.includes(jwt))
})

test('redact: emails and Chinese mobile numbers are masked', () => {
  const out = masked('联系 zhang.san@example.com 或 13812345678')
  assert.ok(!out.includes('zhang.san@example.com'))
  assert.ok(!out.includes('13812345678'))
  assert.ok(out.includes('邮箱'))
  assert.ok(out.includes('手机号'))
})

test('redact: PEM private key blocks are masked', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'
  const out = masked(`here: ${pem}`)
  assert.ok(!out.includes('MIIEow'))
})

test('redact: home directory and username are masked when provided', () => {
  const out = masked('failed at C:\\Users\\alice\\project\\file.txt', {
    homeDir: 'C:\\Users\\alice',
    username: 'alice',
  })
  assert.ok(!out.includes('alice'), out)
})

test('redact: custom patterns apply and invalid ones are ignored', () => {
  const out = redact('token ABC-123-INTERNAL here', { customPatterns: ['ABC-\\d+-INTERNAL', '('] })
  assert.ok(!out.text.includes('ABC-123-INTERNAL'))
  assert.equal(out.total, 1)
})

test('redact: masking is idempotent (browser then host)', () => {
  const once = masked('key sk-abcdefghijklmnopqrstuvwx and 13812345678')
  const twice = masked(once)
  assert.equal(twice, once)
})

test('redact: clean text reports no hits and is unchanged', () => {
  const result = redact('把这段代码改成 TypeScript，保留注释。')
  assert.equal(result.total, 0)
  assert.equal(result.text, '把这段代码改成 TypeScript，保留注释。')
})

test('redact: loopback addresses stay readable for debugging', () => {
  const out = masked('listening on 127.0.0.1:61865')
  assert.ok(out.includes('127.0.0.1'))
})
