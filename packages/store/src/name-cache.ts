// 命名缓存：明细里只有标识（bookId/itemId）时，靠它把书名/章节名补回去。
// 来源是源自己的响应（search/detail 带书名、目录带章节名），第二份事实不自己造。
import { SqliteDb, nowIso } from './sqlite.ts'

export class DbNameCache {
  private readonly db: SqliteDb

  constructor(db: SqliteDb) {
    this.db = db
  }

  remember(kind: 'book' | 'chapter', source: string, ident: string, name: string): void {
    if (!ident || !name) return
    this.db.run(
      `INSERT INTO name_cache (kind, source, ident, name, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(kind, source, ident) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      kind, source, ident, name, nowIso(),
    )
  }

  lookup(kind: 'book' | 'chapter', source: string, ident: string): string {
    return this.db.get<{ name: string }>(
      'SELECT name FROM name_cache WHERE kind = ? AND source = ? AND ident = ?', kind, source, ident,
    )?.name ?? ''
  }

  /** 回填：把明细里空书名/章节名且标识存在的行补上。返回补了多少行 */
  backfill(): { books: number; chapters: number } {
    const books = this.db.run(
      `UPDATE api_call_logs
          SET book_name = (SELECT n.name FROM name_cache n
                            WHERE n.kind = 'book' AND n.source = api_call_logs.source AND n.ident = api_call_logs.book_ident)
        WHERE book_name = '' AND book_ident <> ''
          AND EXISTS (SELECT 1 FROM name_cache n
                       WHERE n.kind = 'book' AND n.source = api_call_logs.source AND n.ident = api_call_logs.book_ident)`,
    ).changes
    const chapters = this.db.run(
      `UPDATE api_call_logs
          SET chapter_title = (SELECT n.name FROM name_cache n
                                WHERE n.kind = 'chapter' AND n.source = api_call_logs.source AND n.ident = api_call_logs.chapter_ident)
        WHERE chapter_title = '' AND chapter_ident <> ''
          AND EXISTS (SELECT 1 FROM name_cache n
                       WHERE n.kind = 'chapter' AND n.source = api_call_logs.source AND n.ident = api_call_logs.chapter_ident)`,
    ).changes
    return { books, chapters }
  }
}
