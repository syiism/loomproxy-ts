// 调用明细（内存实现）：写入口 + 分页查询。SQLite/drizzle 版本接上后**接口不变**。
// 必须有上限——明细是每请求一行，无界就是内存泄漏（迁移-TS-3 §9）。
import type { CallLogPage, CallLogQuery, CallLogRow } from '@loomproxy/contract'

export type NewCallLog = Omit<CallLogRow, 'id' | 'created_at'> & { created_at?: string }

export interface CallLogStore {
  append(row: NewCallLog): CallLogRow
  page(q: CallLogQuery): CallLogPage
  count(): number
  clear(): void
}

const DEFAULT_MAX = 5_000

export class InMemoryCallLogs implements CallLogStore {
  private rows: CallLogRow[] = []
  private seq = 0
  private readonly max: number

  constructor(opts: { max?: number } = {}) {
    this.max = Math.max(1, opts.max ?? DEFAULT_MAX)
  }

  append(row: NewCallLog): CallLogRow {
    const full: CallLogRow = {
      ...row,
      id: ++this.seq,
      created_at: row.created_at ?? new Date().toISOString(),
    }
    this.rows.push(full)
    if (this.rows.length > this.max) this.rows.splice(0, this.rows.length - this.max)
    return full
  }

  page(q: CallLogQuery): CallLogPage {
    const page = Math.max(1, Math.trunc(q.page) || 1)
    const pageSize = Math.min(200, Math.max(1, Math.trunc(q.pageSize) || 20))
    const hit = this.rows.filter((r) => matches(r, q))
    // 新行在前（Go 版 Order("id DESC")）
    hit.reverse()
    const start = (page - 1) * pageSize
    return {
      total: hit.length,
      page,
      page_size: pageSize,
      list: hit.slice(start, start + pageSize),
    }
  }

  count(): number {
    return this.rows.length
  }

  clear(): void {
    this.rows = []
  }
}

function eq(actual: string, want: string | undefined): boolean {
  return want === undefined || want === '' || actual === want
}

function contains(actual: string, want: string | undefined): boolean {
  return want === undefined || want === '' || actual.toLowerCase().includes(want.toLowerCase())
}

function matches(r: CallLogRow, q: CallLogQuery): boolean {
  return (
    eq(r.source, q.source) &&
    eq(r.action, q.action) &&
    eq(r.username, q.username) &&
    eq(r.plugin_version, q.pluginVersion) &&
    eq(r.in_band_code, q.inBandCode) &&
    eq(r.media_type, q.mediaType) &&
    contains(r.keyword, q.keyword) &&
    contains(r.book_name, q.bookName) &&
    contains(r.chapter_title, q.chapterTitle)
  )
}
