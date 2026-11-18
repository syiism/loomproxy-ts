// 命名缓存：明细里只有标识（bookId/itemId）时，靠它把书名/章节名补回去。
// 来源是源自己的响应（search/detail 带书名、目录带章节名），第二份事实不自己造。
//
// **章节键必须是"书+章"的复合键**：章节标识多数只在书内唯一，只用 itemId 会把 A 书的
// 第 3 章标题填进 B 书的第 3 章（Go 的 chapterIdentKey 同口径）。复合键的拼法只在这里出现一次。
import { SqliteDb, nowIso } from './sqlite.ts'

const CHAPTER_KEY_SEP = '|'

function chapterKey(bookIdent: string, ident: string): string {
  return bookIdent && ident ? `${bookIdent}${CHAPTER_KEY_SEP}${ident}` : ''
}

export class DbNameCache {
  private readonly db: SqliteDb

  constructor(db: SqliteDb) {
    this.db = db
  }

  rememberBook(source: string, ident: string, name: string): void {
    if (!ident || !name) return
    this.db.run(
      `INSERT INTO name_cache (kind, source, ident, name, updated_at) VALUES ('book',?,?,?,?)
       ON CONFLICT(kind, source, ident) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      source, ident, name, nowIso(),
    )
  }

  rememberChapter(source: string, bookIdent: string, ident: string, title: string): void {
    const key = chapterKey(bookIdent, ident)
    if (!key || !title) return
    this.db.run(
      `INSERT INTO name_cache (kind, source, ident, name, updated_at) VALUES ('chapter',?,?,?,?)
       ON CONFLICT(kind, source, ident) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      source, key, title, nowIso(),
    )
  }

  lookupBook(source: string, ident: string): string {
    if (!ident) return ''
    return this.db.get<{ name: string }>(
      `SELECT name FROM name_cache WHERE kind = 'book' AND source = ? AND ident = ?`, source, ident,
    )?.name ?? ''
  }

  lookupChapter(source: string, bookIdent: string, ident: string): string {
    const key = chapterKey(bookIdent, ident)
    if (!key) return ''
    return this.db.get<{ name: string }>(
      `SELECT name FROM name_cache WHERE kind = 'chapter' AND source = ? AND ident = ?`, source, key,
    )?.name ?? ''
  }

  /** 面板「内容维度」页脚那两个读数：攒了多少映射 */
  stats(): { books: number; chapters: number } {
    const row = this.db.get<{ books: number; chapters: number }>(
      `SELECT SUM(CASE WHEN kind = 'book' THEN 1 ELSE 0 END) AS books,
              SUM(CASE WHEN kind = 'chapter' THEN 1 ELSE 0 END) AS chapters
         FROM name_cache`,
    )
    return { books: Number(row?.books ?? 0), chapters: Number(row?.chapters ?? 0) }
  }

  /**
   * 回填：把明细里空书名/章节名且标识存在的行补上。返回补了多少行。
   * 章节那一段的键要与 rememberChapter 拼法一致（book_ident||'|'||chapter_ident），
   * 否则回填永远命中不了——两处拼法分家就是"缓存有值、明细分永远空"。
   */
  backfill(): { books: number; chapters: number } {
    const books = this.db.run(
      `UPDATE api_call_logs
          SET book_name = (SELECT n.name FROM name_cache n
                            WHERE n.kind = 'book' AND n.source = api_call_logs.source AND n.ident = api_call_logs.book_ident)
        WHERE book_name = '' AND book_ident <> '' AND content_withheld = 0
          AND EXISTS (SELECT 1 FROM name_cache n
                       WHERE n.kind = 'book' AND n.source = api_call_logs.source AND n.ident = api_call_logs.book_ident)`,
    ).changes
    const chapters = this.db.run(
      `UPDATE api_call_logs
          SET chapter_title = (SELECT n.name FROM name_cache n
                                WHERE n.kind = 'chapter' AND n.source = api_call_logs.source
                                  AND n.ident = api_call_logs.book_ident || '${CHAPTER_KEY_SEP}' || api_call_logs.chapter_ident)
        WHERE chapter_title = '' AND book_ident <> '' AND chapter_ident <> '' AND content_withheld = 0
          AND EXISTS (SELECT 1 FROM name_cache n
                       WHERE n.kind = 'chapter' AND n.source = api_call_logs.source
                         AND n.ident = api_call_logs.book_ident || '${CHAPTER_KEY_SEP}' || api_call_logs.chapter_ident)`,
    ).changes
    return { books, chapters }
  }
}