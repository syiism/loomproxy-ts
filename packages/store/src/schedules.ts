// 数据源定时启停：到点自动启用（面板"每天时段"或"一次性"）。
// 语义只有一条：**窗口内 = 该源启用**；窗口外不回滚管理员手改的 status（一次性用完置 status=0）。
import { type Database, nowIso, type SqlValue } from './sqlite.ts'

export type ScheduleRow = {
  id: number
  data_source_id: number
  mode: 'daily' | 'once'
  start_clock: string
  end_clock: string
  start_at: string | null
  duration_min: number
  status: number
  applied: number
  created_at: string
  updated_at: string
}

export type ScheduleView = ScheduleRow & {
  source_name: string
  source_display: string
  in_window: boolean
  window_text: string
}

export class DbSchedules {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  private clockMinutes(v: string): number {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1
  }

  /** 当前是否在窗口内（daily 用平台时区的钟点；once 用绝对时刻） */
  inWindow(row: ScheduleRow, tzOffsetHours: number, now = Date.now()): boolean {
    if (row.mode === 'once') {
      const start = row.start_at ? Date.parse(row.start_at) : NaN
      if (!Number.isFinite(start)) return false
      return now >= start && now < start + Math.max(1, row.duration_min) * 60_000
    }
    const start = this.clockMinutes(row.start_clock)
    const end = this.clockMinutes(row.end_clock)
    if (start < 0 || end < 0) return false
    const local = now + tzOffsetHours * 3600_000
    const minute = Math.floor((local % 86_400_000) / 60_000)
    return start <= end ? minute >= start && minute < end : minute >= start || minute < end
  }

  windowText(row: ScheduleRow): string {
    if (row.mode === 'once') {
      const start = row.start_at ? new Date(row.start_at) : null
      return start ? `一次性 ${start.toISOString().slice(0, 16).replace('T', ' ')} 起 ${row.duration_min} 分钟` : '一次性（未设起始）'
    }
    return `每天 ${row.start_clock}-${row.end_clock}`
  }

  list(tzOffsetHours: number): ScheduleView[] {
    const rows = this.db.all<ScheduleRow>('SELECT * FROM source_schedules ORDER BY id DESC')
    const nameOf = new Map(
      this.db.all<{ id: number; name: string; display_name: string }>('SELECT id, name, display_name FROM data_sources').map((d) => [d.id, d]),
    )
    return rows.map((r) => {
      const ds = nameOf.get(r.data_source_id)
      return {
        ...r,
        source_name: ds?.name ?? '',
        source_display: ds?.display_name ?? '',
        in_window: this.inWindow(r, tzOffsetHours),
        window_text: this.windowText(r),
      }
    })
  }

  create(input: { sourceIds: number[]; mode: 'daily' | 'once'; startClock?: string; endClock?: string; startAt?: string; durationMin?: number }): number {
    const now = nowIso()
    return this.db.tx(() => {
      let n = 0
      for (const dsId of input.sourceIds) {
        this.db.run(
          `INSERT INTO source_schedules (data_source_id, mode, start_clock, end_clock, start_at, duration_min, status, applied, created_at, updated_at)
           VALUES (?,?,?,?,?,?,1,0,?,?)`,
          dsId, input.mode, input.startClock ?? '', input.endClock ?? '', input.startAt ?? null, input.durationMin ?? 0, now, now,
        )
        n++
      }
      return n
    })
  }

  update(id: number, patch: { start_clock?: string; end_clock?: string; start_at?: string | null; duration_min?: number; status?: number }): void {
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
    this.db.run(`UPDATE source_schedules SET ${sets.join(', ')} WHERE id = ?`, ...params)
  }

  remove(id: number): boolean {
    return this.db.run('DELETE FROM source_schedules WHERE id = ?', id).changes > 0
  }

  /** 维护协程一拍：窗口内启用、窗口外的一次性规则收尾。返回改了哪几条（用于日志） */
  evaluate(tzOffsetHours: number, now = Date.now()): { enabled: number; closed: number } {
    const rows = this.db.all<ScheduleRow>('SELECT * FROM source_schedules WHERE status = 1')
    let enabled = 0
    let closed = 0
    for (const r of rows) {
      const inWin = this.inWindow(r, tzOffsetHours, now)
      if (inWin) {
        const applied = this.db.get<{ n: number }>('SELECT applied FROM source_schedules WHERE id = ?', r.id)?.n ?? 0
        this.db.run('UPDATE data_sources SET status = 1 WHERE id = ?', r.data_source_id)
        if (applied !== 1) {
          this.db.run('UPDATE source_schedules SET applied = 1, updated_at = ? WHERE id = ?', nowIso(), r.id)
          enabled++
        }
        continue
      }
      // 一次性的窗口过去 = 规则结束（status=0）；daily 只在窗口外把 applied 归零，不动管理员的手工开关
      if (r.mode === 'once') {
        this.db.run('UPDATE source_schedules SET status = 0, applied = 0, updated_at = ? WHERE id = ?', nowIso(), r.id)
        closed++
      } else if (r.applied === 1) {
        this.db.run('UPDATE source_schedules SET applied = 0, updated_at = ? WHERE id = ?', nowIso(), r.id)
      }
    }
    return { enabled, closed }
  }
}
