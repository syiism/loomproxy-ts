// DB 版设置的敏感键：来自声明位（内存集合），不依赖 system_settings.sensitive 列
// （线上 MySQL 无此列，Go 也用内存集合）。面板 /admin/settings 曾因查该列 500。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteDb } from '../src/sqlite.ts'
import { DbSettings } from '../src/db-repos2.ts'

function make() {
  const db = new SqliteDb(':memory:')
  db.migrate()
  // 造一张"没有 sensitive 列"的表，模拟线上 MySQL 结构
  db.raw.exec('DROP TABLE system_settings')
  db.raw.exec(`CREATE TABLE system_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, \`key\` TEXT NOT NULL UNIQUE, value TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`)
  return { db, settings: new DbSettings(db) }
}

test('敏感键只写不回显：不依赖 DB 的 sensitive 列', () => {
  const { settings } = make()
  settings.register([
    { key: 'public', type: 'string', default: 'v1', description: '' },
    { key: 'secret', type: 'string', default: 's1', description: '', sensitive: true },
  ])
  const list = settings.list()
  const pub = list.find((r) => r.key === 'public')!
  const sec = list.find((r) => r.key === 'secret')!
  assert.equal(pub.value, 'v1')
  assert.equal(sec.value, '') // 敏感键回空
  assert.deepEqual(settings.sensitiveKeys(), ['secret'])
})

test('敏感键 set("") 保持原值（留空=不改）', () => {
  const { settings } = make()
  settings.register([{ key: 'secret', type: 'string', default: 's1', description: '', sensitive: true }])
  settings.set('secret', '')
  assert.equal(settings.get('secret'), 's1')
})
