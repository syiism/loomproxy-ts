// 口令校验：新口令 scrypt；Go 备份里的旧口令是 bcrypt，迁移后仍要能登录。
import assert from 'node:assert/strict'
import test from 'node:test'
import { hashSync } from 'bcryptjs'
import { hashPassword, verifyPassword } from '../src/db-repos.ts'

test('scrypt 口令：正负例都走原生实现', () => {
  const stored = hashPassword('secret')
  assert.equal(verifyPassword('secret', stored), true)
  assert.equal(verifyPassword('wrong', stored), false)
})

test('bcrypt 旧口令（Go 备份迁移）仍可校验，且错口令不通过', () => {
  const stored = hashSync('legacy-pass', 10)
  assert.ok(stored.startsWith('$2'))
  assert.equal(verifyPassword('legacy-pass', stored), true)
  assert.equal(verifyPassword('wrong', stored), false)
})

test('未知格式的 hash 一律拒绝，不能放行', () => {
  assert.equal(verifyPassword('anything', 'md5:abc'), false)
  assert.equal(verifyPassword('anything', ''), false)
})
