// name_cache 可从调用历史反向重建：明细里带着 book_name/chapter_title + 标识，
// 迁移/切流后据此恢复，不需要读 Go 的 Redis。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteDb } from '../src/sqlite.ts'
import { DbNameCache } from '../src/name-cache.ts'

function seed(db: SqliteDb) {
  db.migrate()
  const ins = (source: string, action: string, bookIdent: string, chapIdent: string, bookName: string, chapTitle: string, withheld = 0) =>
    db.run(
      `INSERT INTO api_call_logs (username,ip,source,action,status,latency_ms,created_at,book_ident,chapter_ident,book_name,chapter_title,content_withheld)
        VALUES ('u','1.1.1.1',?,?,200,1,'2026-01-01T00:00:00.000Z',?,?,?,?,?)`,
      source, action, bookIdent, chapIdent, bookName, chapTitle, withheld,
    )
  ins('fq_novel', 'content', 'b1', 'c1', '书名一', '第1章')
  ins('fq_novel', 'content', 'b1', 'c1', '书名一', '第1章') // 重复：应只留一条映射
  ins('fq_novel', 'content', 'b1', 'c2', '书名一', '第2章')
  ins('sq_novel', 'content', 'b9', 'c9', '', '', 1) // 已抹掉（withheld）：跳过
}

test('recoverFromLogs：按标识提取唯一映射，重复只算一次，withheld 跳过', () => {
  const db = new SqliteDb(':memory:')
  seed(db)
  const cache = new DbNameCache(db)
  const r = cache.recoverFromLogs()
  assert.equal(r.books, 1) // b1（sq 的 b9 被 withheld 跳过）
  assert.equal(r.chapters, 2) // b1|c1、b1|c2
  assert.equal(cache.lookupBook('fq_novel', 'b1'), '书名一')
  assert.equal(cache.lookupChapter('fq_novel', 'b1', 'c1'), '第1章')
  assert.equal(cache.lookupChapter('fq_novel', 'b1', 'c2'), '第2章')
  assert.equal(cache.lookupBook('sq_novel', 'b9'), '')
})

test('recoverFromLogs 幂等：重复调用不新增', () => {
  const db = new SqliteDb(':memory:')
  seed(db)
  const cache = new DbNameCache(db)
  cache.recoverFromLogs()
  const second = cache.recoverFromLogs()
  assert.equal(second.books, 1)
  assert.equal(second.chapters, 2)
})
