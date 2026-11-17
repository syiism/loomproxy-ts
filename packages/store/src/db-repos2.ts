// 设置 / 数据源 / 调用明细的 SQLite 实现（接口与内存版同名同义）。
import type { CallLogPage, CallLogQuery, CallLogRow, SettingDecl, SettingType, SourceMeta } from '@loomproxy/contract'
import { isValidSettingType } from '@loomproxy/contract'
import { SqliteDb, bool, boolInt, nowIso, type SqlValue } from './sqlite.ts'
import type { DataSourceRow, DataSourceStore } from './data-sources.ts'
import type { CallLogStore, NewCallLog } from './call-logs.ts'
import type { SettingsStore, SettingRow } from './settings.ts'

export class DbSettings implements SettingsStore {
  private readonly db: SqliteDb

  constructor(db: SqliteDb) {
    this.db = db
  }

  /** 幂等：行不存在才插；存在只对账 type 与说明，**不覆盖管理员改过的值** */
  register(decls: SettingDecl[]): void {
    for (const d of decls) {
      if (!isValidSettingType(d.type)) throw new Error(`设置项 ${d.key} 的 type 非法: ${d.type}`)
      const cur = this.db.get<{ id: number }>('SELECT id FROM system_settings WHERE key = ?', d.key)
      if (cur) {
        this.db.run('UPDATE system_settings SET type = ?, description = ?, sensitive = ? WHERE key = ?',
          d.type, d.description, boolInt(!!d.sensitive), d.key)
      } else {
        this.db.run(
          'INSERT INTO system_settings (key, value, type, description, sensitive, updated_at) VALUES (?,?,?,?,?,?)',
          d.key, d.default, d.type, d.description, boolInt(!!d.sensitive), nowIso(),
        )
      }
    }
  }

  registerSourceDecls(metas: SourceMeta[]): void {
    for (const m of metas) this.register(m.settings ?? [])
  }

  get(key: string): string {
    const row = this.db.get<{ value: string; sensitive: number }>('SELECT value, sensitive FROM system_settings WHERE key = ?', key)
    if (!row) return ''
    // 敏感键：读接口回空串（只写不回显）
    return bool(row.sensitive) ? '' : row.value
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
    const cur = this.db.get<{ sensitive: number }>('SELECT sensitive FROM system_settings WHERE key = ?', key)
    if (!cur) throw new Error(`设置项 ${key} 未注册，拒绝写入`)
    if (bool(cur.sensitive) && value === '') return
    this.db.run('UPDATE system_settings SET value = ?, updated_at = ? WHERE key = ?', value, nowIso(), key)
  }

  /** 面板用：创建/改说明（与 Go 版 admin/settings 的写入同一张表） */
  upsertRaw(input: { key: string; value: string; type: string; description: string; sensitive?: boolean }): void {
    if (!isValidSettingType(input.type)) throw new Error(`设置项类型非法: ${input.type}`)
    const cur = this.db.get<{ id: number }>('SELECT id FROM system_settings WHERE key = ?', input.key)
    if (cur) {
      this.db.run('UPDATE system_settings SET value = ?, type = ?, description = ?, sensitive = ?, updated_at = ? WHERE key = ?',
        input.value, input.type, input.description, boolInt(!!input.sensitive), nowIso(), input.key)
    } else {
      this.db.run(
        'INSERT INTO system_settings (key, value, type, description, sensitive, updated_at) VALUES (?,?,?,?,?,?)',
        input.key, input.value, input.type, input.description, boolInt(!!input.sensitive), nowIso(),
      )
    }
  }

  remove(key: string): boolean {
    return this.db.run('DELETE FROM system_settings WHERE key = ?', key).changes > 0
  }

  list(): SettingRow[] {
    return this.db.all<{ key: string; value: string; type: string; sensitive: number; description: string }>(
      'SELECT key, value, type, sensitive, description FROM system_settings ORDER BY key',
    ).map((r) => ({
      key: r.key,
      value: bool(r.sensitive) ? '' : r.value,
      type: r.type as SettingType,
      description: r.description,
      sensitive: bool(r.sensitive),
    })) as SettingRow[]
  }

  sensitiveKeys(): string[] {
    return this.db.all<{ key: string }>('SELECT key FROM system_settings WHERE sensitive = 1').map((r) => r.key)
  }
}

export class DbDataSources implements DataSourceStore {
  private readonly db: SqliteDb

  constructor(db: SqliteDb) {
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

  update(id: number, patch: { display_name?: string; category?: string; description?: string; sort_order?: number; status?: number }): void {
    const sets: string[] = []
    const params: SqlValue[] = []
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
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
}

export class DbCallLogs implements CallLogStore {
  private readonly db: SqliteDb

  constructor(db: SqliteDb) {
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

  /** 源/动作维度的读数（面板「监控」页与总览） */
  stats(): Array<Record<string, SqlValue>> {
    return this.db.all<Record<string, SqlValue>>(
      `SELECT source, action, total, success, failed, total_latency_ms, max_latency_ms, updated_at
         FROM api_call_stats ORDER BY total DESC`,
    )
  }

  /** 内容维度榜（dim: keyword|book|chapter|media） */
  subjects(dim: string, days: number): Array<{ name: string; count: number }> {
    const col = dim === 'book' ? 'book_name' : dim === 'chapter' ? 'chapter_title' : dim === 'media' ? 'media' : 'keyword'
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    return this.db.all<{ name: string; count: number }>(
      `SELECT ${col} AS name, COUNT(*) AS count FROM api_call_logs
        WHERE ${col} <> '' AND created_at >= ? GROUP BY ${col} ORDER BY count DESC LIMIT 50`,
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
