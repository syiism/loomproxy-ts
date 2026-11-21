// 设置 / 数据源 / 调用明细的 SQLite 实现（接口与内存版同名同义）。
import type {
  CallLogPage, CallLogQuery, CallLogRow, MediaOrEmpty, SettingDecl, SettingType, SourceMeta,
  SubjectCoverageRow, SubjectDim, SubjectItem, SubjectWindowQuery,
} from '@loomproxy/contract'
import { isValidSettingType, mediaLabel } from '@loomproxy/contract'
import { type Database, bool, boolInt, nowIso, type SqlValue } from './sqlite.ts'
import type { DataSourceRow, DataSourceStore } from './data-sources.ts'
import type { CallLogStore, MonitorRow, NewCallLog } from './call-logs.ts'
import type { SettingsStore, SettingRow } from './settings.ts'

/** 维度 → 列与统计口径（唯一映射表；请求可控的只是键） */
const SUBJECT_DIM_COLUMNS: Record<
  SubjectDim,
  { column: string; onlyPresent: boolean; onlyActions: string[]; byVisitors: boolean }
> = {
  keyword: { column: 'keyword', onlyPresent: true, onlyActions: [], byVisitors: false },
  book: { column: 'book_name', onlyPresent: true, onlyActions: ['content'], byVisitors: true },
  chapter: { column: 'chapter_title', onlyPresent: true, onlyActions: ['content'], byVisitors: false },
  // 媒介要的是全量分布（"这一站有多少听书"），未判定的空值也要数
  media: { column: 'media', onlyPresent: false, onlyActions: [], byVisitors: false },
}

export class DbSettings implements SettingsStore {
  private readonly db: Database
  // 敏感键集合：来自声明位（SettingDecl.sensitive），与 Go 的 SensitiveSettingKeys 同口径。
  // 不依赖 DB 的 sensitive 列——线上 MySQL 的 system_settings 没有这一列（Go 也用内存集合）。
  private readonly sensitive = new Set<string>()

  constructor(db: Database) {
    this.db = db
  }

  /** 幂等：行不存在才插；存在只对账 type 与说明，**不覆盖管理员改过的值** */
  register(decls: SettingDecl[]): void {
    for (const d of decls) {
      if (!isValidSettingType(d.type)) throw new Error(`设置项 ${d.key} 的 type 非法: ${d.type}`)
      if (d.sensitive) this.sensitive.add(d.key)
      const cur = this.db.get<{ id: number }>('SELECT id FROM system_settings WHERE key = ?', d.key)
      if (cur) {
        this.db.run('UPDATE system_settings SET type = ?, description = ? WHERE key = ?',
          d.type, d.description, d.key)
      } else {
        this.db.run(
          'INSERT INTO system_settings (key, value, type, description, updated_at) VALUES (?,?,?,?,?)',
          d.key, d.default, d.type, d.description, nowIso(),
        )
      }
    }
  }

  registerSourceDecls(metas: SourceMeta[]): void {
    for (const m of metas) this.register(m.settings ?? [])
  }

  /**
   * 读设置值：**含敏感键的真值**。
   * 「敏感键只写不回显」约束的是**面板/接口的回显**（`list()` 抹值），不是"自己的消费方也读不到"——
   * 源声明的密钥（manifest settings 里 sensitive:true）如果这里也返回空串，那个源就永远拿不到自己的密钥，
   * 面板上填了也等于没填（2026-11-18 实测）。
   */
  get(key: string): string {
    return this.db.get<{ value: string }>('SELECT value FROM system_settings WHERE key = ?', key)?.value ?? ''
  }

  /** 全部键值（**含敏感键真值**）：worker 隔离的源在主线程拿不到 settings 对象，靠这份快照 */
  rawValues(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const r of this.db.all<{ key: string; value: string }>('SELECT key, value FROM system_settings')) out[r.key] = r.value
    return out
  }

  getBool(key: string, def: boolean): boolean {
    const v = this.get(key).trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(v)) return true
    if (['0', 'false', 'no', 'off'].includes(v)) return false
    return def
  }

  getInt(key: string, def: number): number {
    const v = this.get(key).trim()
    if (!v) return def
    const n = Number(v)
    return Number.isFinite(n) ? Math.trunc(n) : def
  }

  /** 未注册的键拒绝写入（与内存版同口径：设置项必须先在声明位/面板登记） */
  set(key: string, value: string): void {
    const cur = this.db.get<{ id: number }>('SELECT id FROM system_settings WHERE key = ?', key)
    if (!cur) throw new Error(`设置项 ${key} 未注册，拒绝写入`)
    if (this.sensitive.has(key) && value === '') return
    this.db.run('UPDATE system_settings SET value = ?, updated_at = ? WHERE key = ?', value, nowIso(), key)
  }

  /** 面板用：创建/改说明（与 Go 版 admin/settings 的写入同一张表） */
  upsertRaw(input: { key: string; value: string; type: string; description: string; sensitive?: boolean }): void {
    if (!isValidSettingType(input.type)) throw new Error(`设置项类型非法: ${input.type}`)
    if (input.sensitive) this.sensitive.add(input.key)
    const cur = this.db.get<{ id: number }>('SELECT id FROM system_settings WHERE key = ?', input.key)
    if (cur) {
      this.db.run('UPDATE system_settings SET value = ?, type = ?, description = ?, updated_at = ? WHERE key = ?',
        input.value, input.type, input.description, nowIso(), input.key)
    } else {
      this.db.run(
        'INSERT INTO system_settings (key, value, type, description, updated_at) VALUES (?,?,?,?,?)',
        input.key, input.value, input.type, input.description, nowIso(),
      )
    }
  }

  remove(key: string): boolean {
    this.sensitive.delete(key)
    return this.db.run('DELETE FROM system_settings WHERE key = ?', key).changes > 0
  }

  list(): SettingRow[] {
    return this.db.all<{ key: string; value: string; type: string; description: string }>(
      'SELECT key, value, type, description FROM system_settings ORDER BY key',
    ).map((r) => ({
      key: r.key,
      value: this.sensitive.has(r.key) ? '' : r.value,
      type: r.type as SettingType,
      description: r.description,
      sensitive: this.sensitive.has(r.key),
    })) as SettingRow[]
  }

  sensitiveKeys(): string[] {
    return [...this.sensitive].sort()
  }
}

export class DbDataSources implements DataSourceStore {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  /** 插件加载时幂等 upsert：不覆盖管理员改过的 status（只有 setStatus/update 才改） */
  upsert(meta: SourceMeta): void {
    const cur = this.db.get<{ id: number }>('SELECT id FROM data_sources WHERE name = ?', meta.code)
    const now = nowIso()
    if (cur) {
      this.db.run(
        'UPDATE data_sources SET display_name = ?, category = ?, description = ?, sort_order = ?, media_type = ?, updated_at = ? WHERE name = ?',
        meta.display, meta.category, meta.description ?? '', meta.sort_order, meta.media_type ?? null, now, meta.code,
      )
      return
    }
    this.db.run(
      `INSERT INTO data_sources (name, display_name, category, description, sort_order, status, media_type, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      meta.code, meta.display, meta.category, meta.description ?? '', meta.sort_order, meta.status, meta.media_type ?? null, now, now,
    )
  }

  setStatus(name: string, status: number): void {
    this.db.run('UPDATE data_sources SET status = ?, updated_at = ? WHERE name = ?', status, nowIso(), name)
  }

  get(name: string): DataSourceRow | undefined {
    return this.db.get<DataSourceRow>('SELECT * FROM data_sources WHERE name = ?', name)
  }

  listEnabled(): DataSourceRow[] {
    return this.db.all<DataSourceRow>('SELECT * FROM data_sources WHERE status = 1 ORDER BY sort_order, id')
  }

  listAll(): Array<DataSourceRow & { created_at: string; updated_at: string }> {
    return this.db.all('SELECT * FROM data_sources ORDER BY sort_order, id') as Array<DataSourceRow & { created_at: string; updated_at: string }>
  }

  create(input: { name: string; display_name: string; category?: string; description?: string; sort_order?: number; status?: number }): number {
    const now = nowIso()
    return this.db.run(
      `INSERT INTO data_sources (name, display_name, category, description, sort_order, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      input.name, input.display_name, input.category ?? '', input.description ?? '', input.sort_order ?? 0, input.status ?? 1, now, now,
    ).lastInsertRowid
  }

  /** 只认这五个列：面板可能顺手传 rank_public/name 之类，直接拼进 SQL 会变成 500 */
  update(
    id: number,
    patch: { display_name?: string; category?: string; description?: string; sort_order?: number; status?: number; group_id?: number | null },
  ): void {
    const ALLOWED = new Set(['display_name', 'category', 'description', 'sort_order', 'status', 'group_id'])
    const sets: string[] = []
    const params: SqlValue[] = []
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !ALLOWED.has(k)) continue
      sets.push(`${k} = ?`)
      params.push(v as SqlValue)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    params.push(nowIso(), id)
    this.db.run(`UPDATE data_sources SET ${sets.join(', ')} WHERE id = ?`, ...params)
  }

  remove(id: number): boolean {
    // 只删行，不删历史日志（日志按 source 文本关联）
    return this.db.run('DELETE FROM data_sources WHERE id = ?', id).changes > 0
  }

  /**
   * 删除数据源 + 所有按 code 关联的配置/授权/成本/定时任务/源配置和名称缓存，同一个事务里完成。
   * 历史审计（api_call_logs / api_call_stats / quota_usage_logs / quota_transfer_logs）按源文本关联，
   * 是账本不是配置，一律保留——删掉等于毁掉"这个源过去做过什么"的证据。
   * user_quota_overrides 的 SQL 故意写成 `scope = ? AND target IN (?)`：MysqlDb 的 overrideQueryFix
   * 会把它翻成线上真实的 group_code 列。
   */
  removeWithRefs(id: number, name: string): boolean {
    return this.db.tx(() => {
      if (!this.db.run('DELETE FROM data_sources WHERE id = ?', id).changes) return false
      this.db.run('DELETE FROM source_schedules WHERE data_source_id = ?', id)
      this.db.run("DELETE FROM quota_limits WHERE scope = 'source' AND target = ?", name)
      this.db.run('DELETE FROM quota_costs WHERE group_code = ?', name)
      this.db.run('DELETE FROM quota_cost_plans WHERE group_code = ?', name)
      this.db.run('DELETE FROM user_quota_overrides WHERE scope = ? AND target IN (?)', 'source', name)
      this.db.run('DELETE FROM platform_source_configs WHERE source_name = ?', name)
      this.db.run('DELETE FROM user_source_configs WHERE source_name = ?', name)
      this.db.run('DELETE FROM name_cache WHERE source = ?', name)
      return true
    })
  }
}

export class DbCallLogs implements CallLogStore {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  append(row: NewCallLog): CallLogRow {
    const created = row.created_at ?? nowIso()
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO api_call_logs (username, ip, source, action, status, in_band_error, in_band_reason, in_band_code,
         latency_ms, created_at, keyword, book_name, chapter_title, book_ident, chapter_ident, media, result_count,
         content_withheld, plugin_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.username, row.ip, row.source, row.action, row.status, boolInt(row.in_band_error), row.in_band_reason,
      row.in_band_code, row.latency_ms, created, row.keyword, row.book_name, row.chapter_title, row.book_ident,
      row.chapter_ident, row.media_type, row.result_count, boolInt(row.content_withheld), row.plugin_version,
    )
    // 聚合表：明细可以不永久留（MONITOR_RETENTION_DAYS），聚合要留下来回答"这个源稳不稳"
    this.db.run(
      `INSERT INTO api_call_stats (source, action, total, success, failed, total_latency_ms, max_latency_ms, updated_at)
       VALUES (?,?,1,?,?,?,?,?)
       ON CONFLICT(source, action) DO UPDATE SET
         total = total + 1,
         success = success + excluded.success,
         failed = failed + excluded.failed,
         total_latency_ms = total_latency_ms + excluded.total_latency_ms,
         max_latency_ms = MAX(max_latency_ms, excluded.max_latency_ms),
         updated_at = excluded.updated_at`,
      row.source, row.action, row.status < 400 && !row.in_band_error ? 1 : 0, row.status >= 400 || row.in_band_error ? 1 : 0,
      row.latency_ms, row.latency_ms, created,
    )
    return { ...row, id: lastInsertRowid, created_at: created }
  }

  page(q: CallLogQuery): CallLogPage {
    const page = Math.max(1, Math.trunc(q.page) || 1)
    const pageSize = Math.min(200, Math.max(1, Math.trunc(q.pageSize) || 20))
    const where: string[] = []
    const params: SqlValue[] = []
    const eq = (col: string, v?: string) => {
      if (v) { where.push(`${col} = ?`); params.push(v) }
    }
    const like = (col: string, v?: string) => {
      if (v) { where.push(`${col} LIKE ?`); params.push(`%${v}%`) }
    }
    eq('source', q.source)
    eq('action', q.action)
    eq('username', q.username)
    eq('plugin_version', q.pluginVersion)
    eq('in_band_code', q.inBandCode)
    eq('media', q.mediaType)
    like('keyword', q.keyword)
    like('book_name', q.bookName)
    like('chapter_title', q.chapterTitle)
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM api_call_logs ${clause}`, ...params)?.n ?? 0
    const rows = this.db.all<Record<string, SqlValue>>(
      `SELECT * FROM api_call_logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...params, pageSize, (page - 1) * pageSize,
    ).map(toRow)
    return { total, page, page_size: pageSize, list: rows }
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM api_call_logs')?.n ?? 0
  }

  clear(): void {
    this.db.run('DELETE FROM api_call_logs')
  }

  /** 接口监控：自 sinceIso 起的逐源/动作聚合（内存计数快照语义，重启后起点刷新） */
  windowStats(sinceIso: string): MonitorRow[] {
    const rows = this.db.all<Record<string, SqlValue>>(
      `SELECT source, action,
              COUNT(*) AS total,
              SUM(CASE WHEN status < 400 AND in_band_error = 0 THEN 1 ELSE 0 END) AS success,
              SUM(CASE WHEN status >= 400 OR in_band_error = 1 THEN 1 ELSE 0 END) AS failed,
              COALESCE(SUM(latency_ms), 0) AS total_latency_ms,
              COALESCE(MAX(latency_ms), 0) AS max_latency_ms,
              MAX(created_at) AS last_called_at
         FROM api_call_logs WHERE created_at >= ?
        GROUP BY source, action ORDER BY total DESC`,
      sinceIso,
    )
    return rows.map((r) => ({
      source: String(r['source'] ?? ''),
      action: String(r['action'] ?? ''),
      total: Number(r['total'] ?? 0),
      success: Number(r['success'] ?? 0),
      failed: Number(r['failed'] ?? 0),
      total_latency_ms: Number(r['total_latency_ms'] ?? 0),
      max_latency_ms: Number(r['max_latency_ms'] ?? 0),
      last_called_at: String(r['last_called_at'] ?? ''),
    }))
  }

  /** 源/动作维度的读数（面板「监控」页与总览） */
  stats(): Array<Record<string, SqlValue>> {
    return this.db.all<Record<string, SqlValue>>(
      `SELECT source, action, total, success, failed, total_latency_ms, max_latency_ms, updated_at
         FROM api_call_stats ORDER BY total DESC`,
    )
  }

  /**
   * 内容维度榜（阅读记录）：dim 白名单在契约里，列名只取自本表 —— 请求可控的只是维度键，
   * 拼进 SQL 的列名永远是下面这张映射里取出来的字面量，值一律走绑定参数。
   *
   * 两条口径与 Go 的 subjectrank 对齐，缺了就会"记录了但榜上是错的"：
   * ① book/chapter 只统计 content：一次打开书目会连着产生 detail 与多页目录，
   *    全计入等于把同一本书凭空乘上几倍；
   * ② 书名维度的排名数字用**同数据源内的访问人数**（按 username 去重、匿名退到 IP）：
   *    一条正文明细只是一章，按次数排等于把"谁在读"写成"被翻了多少章"。
   */
  subjects(q: SubjectWindowQuery): SubjectItem[] {
    const dim = SUBJECT_DIM_COLUMNS[q.dim]
    if (!dim) return []
    const where: string[] = ['created_at >= ?']
    const params: SqlValue[] = [q.since]
    if (dim.onlyPresent) where.push(`${dim.column} <> ''`)
    if (dim.onlyActions.length > 0) where.push(`action IN (${dim.onlyActions.map(() => '?').join(',')})`)
    if (dim.onlyActions.length > 0) params.push(...dim.onlyActions)
    if (q.source) { where.push('source = ?'); params.push(q.source) }
    if (q.media) { where.push('media = ?'); params.push(q.media) }
    if (q.allowSources !== undefined) {
      // 白名单是空集 = 没有任何源可见（不必查库）；非 undefined 即生效
      if (q.allowSources.length === 0) return []
      where.push(`source IN (${q.allowSources.map(() => '?').join(',')})`)
      params.push(...q.allowSources)
    }
    const identCol = q.dim === 'book' ? ', MAX(CASE WHEN book_ident <> \'\' THEN id ELSE 0 END) AS ident_id' : ''
    const rows = this.db.all<Record<string, SqlValue>>(
      `SELECT ${dim.column} AS name, source,
              COUNT(*) AS requests,
              COUNT(DISTINCT COALESCE(NULLIF(username, ''), ip)) AS visitors,
              SUM(CASE WHEN status >= 200 AND status < 300 AND in_band_error = 0 THEN 1 ELSE 0 END) AS success,
              COALESCE(SUM(latency_ms), 0) AS latency,
              COALESCE(MAX(latency_ms), 0) AS max_latency,
              SUM(CASE WHEN status >= 200 AND status < 300 AND result_count = 0 THEN 1 ELSE 0 END) AS empty_count,
              MAX(id) AS last_id${identCol}
         FROM api_call_logs
        WHERE ${where.join(' AND ')}
        GROUP BY ${dim.column}, source`,
      ...params,
    )

    // 跨源合并：人数不能直接相加（同一个人既读过 A 源又读过 B 源会被数两次），
    // 但每一行本来是"同一源内去重"的人数，按源相加正是面板口径说明里那句"跨源相加不再去重"
    type Acc = {
      requests: number; visitors: number; success: number; latency: number; max: number; empty: number
      sources: Set<string>; lastId: number; identId: number
    }
    const merged = new Map<string, Acc>()
    for (const r of rows) {
      const name = String(r['name'] ?? '')
      if (!name) continue
      const acc = merged.get(name) ?? {
        requests: 0, visitors: 0, success: 0, latency: 0, max: 0, empty: 0,
        sources: new Set<string>(), lastId: 0, identId: 0,
      }
      acc.requests += Number(r['requests'] ?? 0)
      acc.visitors += Number(r['visitors'] ?? 0)
      acc.success += Number(r['success'] ?? 0)
      acc.latency += Number(r['latency'] ?? 0)
      acc.max = Math.max(acc.max, Number(r['max_latency'] ?? 0))
      acc.empty += Number(r['empty_count'] ?? 0)
      if (String(r['source'] ?? '')) acc.sources.add(String(r['source']))
      acc.lastId = Math.max(acc.lastId, Number(r['last_id'] ?? 0))
      acc.identId = Math.max(acc.identId, Number(r['ident_id'] ?? 0))
      merged.set(name, acc)
    }

    // 榜尾两栏（最近调用、书目标识）整页一次点查取回，不在循环里逐条查
    const idSet = new Set<number>()
    for (const a of merged.values()) { if (a.lastId) idSet.add(a.lastId); if (a.identId) idSet.add(a.identId) }
    const byId = new Map<number, { created_at: string; book_ident: string }>()
    if (idSet.size > 0) {
      const ids = [...idSet]
      for (const r of this.db.all<Record<string, SqlValue>>(
        `SELECT id, created_at, book_ident FROM api_call_logs WHERE id IN (${ids.map(() => '?').join(',')})`,
        ...ids,
      )) {
        byId.set(Number(r['id']), { created_at: String(r['created_at'] ?? ''), book_ident: String(r['book_ident'] ?? '') })
      }
    }

    const items: SubjectItem[] = []
    for (const [name, a] of merged) {
      if (a.requests === 0) continue
      const total = dim.byVisitors ? a.visitors : a.requests
      const item: SubjectItem = {
        name,
        ...(q.dim === 'media' ? { label: mediaLabel(name as MediaOrEmpty) } : {}),
        total,
        visitors: a.visitors,
        requests: a.requests,
        success: a.success,
        failed: a.requests - a.success,
        // 成功率与平均耗时一律按**请求**算：人数当分母会把"一个人读三十章"的失败率稀释成三十分之一
        success_rate: a.requests > 0 ? (a.success / a.requests) * 100 : 0,
        avg_latency_ms: a.requests > 0 ? Math.trunc(a.latency / a.requests) : 0,
        max_latency_ms: a.max,
        empty_results: a.empty,
        sources: [...a.sources].sort(),
      }
      const last = a.lastId ? byId.get(a.lastId) : undefined
      if (last?.created_at) item.last_called_at = last.created_at
      if (dim.byVisitors && a.identId) {
        const ident = byId.get(a.identId)?.book_ident ?? ''
        if (ident) item.book_id = ident
      }
      items.push(item)
    }
    items.sort((x, y) => (y.total - x.total) || x.name.localeCompare(y.name))
    const limit = q.limit ?? 0
    return limit > 0 ? items.slice(0, limit) : items
  }

  /**
   * 内容维度覆盖率（源 × 接口）：哪一格常年不满，先看同行的失败与带内失败。
   * 缺格有两种合理成因，必须分开报，否则读数会替它们背锅：
   * 失败/带内失败五维本来就全空；用户自己关掉留存（withheld）也不进分母。
   */
  coverage(q: { since: string; source?: string }): SubjectCoverageRow[] {
    const where: string[] = ['created_at >= ?']
    const params: SqlValue[] = [q.since]
    if (q.source) { where.push('source = ?'); params.push(q.source) }
    return this.db.all<Record<string, SqlValue>>(
      `SELECT source, action, COUNT(*) AS rows,
              SUM(CASE WHEN book_name <> '' THEN 1 ELSE 0 END) AS has_book_name,
              SUM(CASE WHEN book_ident <> '' THEN 1 ELSE 0 END) AS has_book_ident,
              SUM(CASE WHEN chapter_title <> '' THEN 1 ELSE 0 END) AS has_chapter_title,
              SUM(CASE WHEN media <> '' THEN 1 ELSE 0 END) AS has_media,
              SUM(CASE WHEN status >= 400 OR in_band_error = 1 THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN in_band_error = 1 THEN 1 ELSE 0 END) AS in_band_failed,
              SUM(CASE WHEN content_withheld = 1 THEN 1 ELSE 0 END) AS withheld
         FROM api_call_logs WHERE ${where.join(' AND ')}
        GROUP BY source, action ORDER BY source, action`,
      ...params,
    ).map((r) => ({
      source: String(r['source'] ?? ''),
      action: String(r['action'] ?? ''),
      rows: Number(r['rows'] ?? 0),
      has_book_name: Number(r['has_book_name'] ?? 0),
      has_book_ident: Number(r['has_book_ident'] ?? 0),
      has_chapter_title: Number(r['has_chapter_title'] ?? 0),
      has_media: Number(r['has_media'] ?? 0),
      failed: Number(r['failed'] ?? 0),
      in_band_failed: Number(r['in_band_failed'] ?? 0),
      withheld: Number(r['withheld'] ?? 0),
      // search/explore 本就没有"这一本"，空不是缺陷
      expect_book: !['search', 'explore'].includes(String(r['action'] ?? '')),
    }))
  }

  /** 按天 × 源的调用趋势（面板趋势图；读的是明细，聚合表没有时间维度） */
  trend(days: number): Array<{ day: string; source: string; total: number; success: number; failed: number }> {
    const since = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString()
    return this.db.all<{ day: string; source: string; total: number; success: number; failed: number }>(
      `SELECT substr(created_at, 1, 10) AS day, source,
              COUNT(*) AS total,
              SUM(CASE WHEN status < 400 AND in_band_error = 0 THEN 1 ELSE 0 END) AS success,
              SUM(CASE WHEN status >= 400 OR in_band_error = 1 THEN 1 ELSE 0 END) AS failed
         FROM api_call_logs WHERE created_at >= ?
        GROUP BY day, source ORDER BY day, source`,
      since,
    )
  }
}

function toRow(r: Record<string, SqlValue>): CallLogRow {
  return {
    id: Number(r['id']),
    username: String(r['username'] ?? ''),
    ip: String(r['ip'] ?? ''),
    source: String(r['source'] ?? ''),
    action: String(r['action'] ?? ''),
    status: Number(r['status'] ?? 0),
    in_band_error: bool(r['in_band_error']),
    in_band_reason: String(r['in_band_reason'] ?? ''),
    in_band_code: String(r['in_band_code'] ?? ''),
    latency_ms: Number(r['latency_ms'] ?? 0),
    created_at: String(r['created_at'] ?? ''),
    keyword: String(r['keyword'] ?? ''),
    book_name: String(r['book_name'] ?? ''),
    chapter_title: String(r['chapter_title'] ?? ''),
    book_ident: String(r['book_ident'] ?? ''),
    chapter_ident: String(r['chapter_ident'] ?? ''),
    media_type: String(r['media'] ?? '') as CallLogRow['media_type'],
    result_count: Number(r['result_count'] ?? 0),
    content_withheld: bool(r['content_withheld']),
    plugin_version: String(r['plugin_version'] ?? ''),
  }
}
