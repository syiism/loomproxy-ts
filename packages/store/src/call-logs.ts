// 调用明细（内存实现）：写入口 + 分页查询。SQLite/drizzle 版本接上后**接口不变**。
// 必须有上限——明细是每请求一行，无界就是内存泄漏（迁移-TS-3 §9）。
import type {
  CallLogPage, CallLogQuery, CallLogRow, SubjectCoverageRow, SubjectItem, SubjectWindowQuery,
} from '@loomproxy/contract'

export type NewCallLog = Omit<CallLogRow, 'id' | 'created_at'> & { created_at?: string }

/** 维度 → 列与统计口径（唯一映射表；请求可控的只是键，列名永远是这里的字面量） */
const DIM: Record<SubjectWindowQuery['dim'], { column: keyof CallLogRow; onlyPresent: boolean; onlyActions: string[]; byVisitors: boolean }> = {
  keyword: { column: 'keyword', onlyPresent: true, onlyActions: [], byVisitors: false },
  book: { column: 'book_name', onlyPresent: true, onlyActions: ['content'], byVisitors: true },
  chapter: { column: 'chapter_title', onlyPresent: true, onlyActions: ['content'], byVisitors: false },
  media: { column: 'media_type', onlyPresent: false, onlyActions: [], byVisitors: false },
}

/** 接口监控逐源/动作读数（启动以来窗口） */
export type MonitorRow = {
  source: string; action: string; total: number; success: number; failed: number
  total_latency_ms: number; max_latency_ms: number; last_called_at: string
}

export interface CallLogStore {
  append(row: NewCallLog): CallLogRow
  page(q: CallLogQuery): CallLogPage
  count(): number
  clear(): void
  /** 接口监控：自 sinceIso 起的逐源/动作聚合（对应 Go 的内存计数快照，重启后起点刷新） */
  windowStats(sinceIso: string): MonitorRow[]
  /** 内容维度榜（阅读记录）；窗口起点由调用方按时区日界算好 */
  subjects(q: SubjectWindowQuery): SubjectItem[]
  /** 内容维度覆盖率（源 × 接口） */
  coverage(q: { since: string; source?: string }): SubjectCoverageRow[]
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

  windowStats(sinceIso: string): MonitorRow[] {
    const acc = new Map<string, MonitorRow>()
    for (const r of this.rows) {
      if (r.created_at < sinceIso) continue
      const key = `${r.source}/${r.action}`
      let row = acc.get(key)
      if (!row) {
        row = {
          source: r.source, action: r.action, total: 0, success: 0, failed: 0,
          total_latency_ms: 0, max_latency_ms: 0, last_called_at: r.created_at,
        }
        acc.set(key, row)
      }
      row.total++
      if (r.status < 400 && !r.in_band_error) row.success++
      else row.failed++
      row.total_latency_ms += r.latency_ms
      row.max_latency_ms = Math.max(row.max_latency_ms, r.latency_ms)
      if (r.created_at > row.last_called_at) row.last_called_at = r.created_at
    }
    return [...acc.values()]
  }

  subjects(q: SubjectWindowQuery): SubjectItem[] {
    const dim = DIM[q.dim]
    if (!dim) return []
    if (q.allowSources !== undefined && q.allowSources.length === 0) return []
    const hit = this.rows.filter(
      (r) =>
        r.created_at >= q.since &&
        (!dim.onlyPresent || String(r[dim.column] ?? '') !== '') &&
        (dim.onlyActions.length === 0 || dim.onlyActions.includes(r.action)) &&
        (!q.source || r.source === q.source) &&
        (!q.media || r.media_type === q.media) &&
        (q.allowSources === undefined || q.allowSources.includes(r.source)),
    )
    const acc = new Map<string, { a: SubjectItem; sources: Set<string> }>()
    for (const r of hit) {
      const name = String(r[dim.column] ?? '')
      if (!name) continue
      const cur = acc.get(name)
      const item: SubjectItem = cur?.a ?? {
        name, total: 0, visitors: 0, requests: 0, success: 0, failed: 0, success_rate: 0,
        avg_latency_ms: 0, max_latency_ms: 0, empty_results: 0, sources: [],
      }
      const sources = cur?.sources ?? new Set<string>()
      item.requests += 1
      item.success += r.status >= 200 && r.status < 300 && !r.in_band_error ? 1 : 0
      if (r.status >= 200 && r.status < 300 && r.result_count === 0) item.empty_results += 1
      item.max_latency_ms = Math.max(item.max_latency_ms, r.latency_ms)
      item.avg_latency_ms += r.latency_ms
      if (r.source) sources.add(r.source)
      if (!item.last_called_at || r.created_at > item.last_called_at) item.last_called_at = r.created_at
      if (dim.byVisitors && !item.book_id && r.book_ident) item.book_id = r.book_ident
      acc.set(name, { a: item, sources })
    }
    for (const { a, sources } of acc.values()) {
      // 内存版没有 SQL 的 DISTINCT 可用：同源同人只算一个。跨源相加不再去重（与面板口径一致）
      a.visitors = new Set(hit.filter((r) => String(r[dim.column] ?? '') === a.name).map((r) => `${r.source}:${r.username || r.ip}`)).size
      a.failed = a.requests - a.success
      a.success_rate = a.requests > 0 ? (a.success / a.requests) * 100 : 0
      a.avg_latency_ms = a.requests > 0 ? Math.trunc(a.avg_latency_ms / a.requests) : 0
      a.sources = [...sources].sort()
      a.total = dim.byVisitors ? a.visitors : a.requests
    }
    const items = [...acc.values()].map((x) => x.a).sort((x, y) => y.total - x.total || x.name.localeCompare(y.name))
    return (q.limit ?? 0) > 0 ? items.slice(0, q.limit) : items
  }

  coverage(q: { since: string; source?: string }): SubjectCoverageRow[] {
    const groups = new Map<string, SubjectCoverageRow>()
    for (const r of this.rows) {
      if (r.created_at < q.since) continue
      if (q.source && r.source !== q.source) continue
      const key = `${r.source}\u0000${r.action}`
      const row = groups.get(key) ?? {
        source: r.source, action: r.action, rows: 0, has_book_name: 0, has_book_ident: 0,
        has_chapter_title: 0, has_media: 0, failed: 0, in_band_failed: 0, withheld: 0, expect_book: true,
      }
      row.rows += 1
      if (r.book_name) row.has_book_name += 1
      if (r.book_ident) row.has_book_ident += 1
      if (r.chapter_title) row.has_chapter_title += 1
      if (r.media_type) row.has_media += 1
      if (r.status >= 400 || r.in_band_error) row.failed += 1
      if (r.in_band_error) row.in_band_failed += 1
      if (r.content_withheld) row.withheld += 1
      row.expect_book = !['search', 'explore'].includes(r.action)
      groups.set(key, row)
    }
    return [...groups.values()].sort((x, y) => x.source.localeCompare(y.source) || x.action.localeCompare(y.action))
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
