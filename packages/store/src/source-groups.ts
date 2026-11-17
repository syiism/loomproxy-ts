// 数据源分组：**视图 + 批量操作单位**，不参与任何键控（额度/计费/限速一律按源码）。
// 组停用不摘成员：成员按「未分组」渲染（分组不是准入开关）。
import { SqliteDb, nowIso } from './sqlite.ts'
import type { DbQuota } from './quota.ts'

export type GroupRow = {
  id: number
  name: string
  description: string
  sort_order: number
  status: number
  member_count: number
}

export class DbSourceGroups {
  private readonly db: SqliteDb
  private readonly quota: DbQuota

  constructor(db: SqliteDb, quota: DbQuota) {
    this.db = db
    this.quota = quota
  }

  list(): GroupRow[] {
    return this.db.all<GroupRow>(
      `SELECT g.id, g.name, g.description, g.sort_order, g.status,
              (SELECT COUNT(*) FROM data_sources d WHERE d.group_id = g.id) AS member_count
         FROM source_groups g ORDER BY g.sort_order, g.id`,
    )
  }

  create(input: { name: string; description?: string; sort_order?: number }): GroupRow {
    const now = nowIso()
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO source_groups (name, description, sort_order, status, created_at, updated_at) VALUES (?,?,?,1,?,?)',
      input.name, input.description ?? '', input.sort_order ?? 0, now, now,
    )
    return this.list().find((g) => g.id === lastInsertRowid)!
  }

  update(id: number, patch: { name?: string; description?: string; sort_order?: number; status?: number }): GroupRow | undefined {
    const sets: string[] = []
    const params: Array<string | number> = []
    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name) }
    if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
    if (patch.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(patch.sort_order) }
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
    if (sets.length > 0) {
      sets.push('updated_at = ?')
      params.push(nowIso(), id)
      this.db.run(`UPDATE source_groups SET ${sets.join(', ')} WHERE id = ?`, ...params)
    }
    return this.list().find((g) => g.id === id)
  }

  remove(id: number): boolean {
    return this.db.tx(() => {
      this.db.run('UPDATE data_sources SET group_id = NULL WHERE group_id = ?', id)
      return this.db.run('DELETE FROM source_groups WHERE id = ?', id).changes > 0
    })
  }

  /** 成员覆盖式写入（空数组 = 全部移出组） */
  setMembers(id: number, sourceNames: string[]): number {
    return this.db.tx(() => {
      this.db.run('UPDATE data_sources SET group_id = NULL WHERE group_id = ?', id)
      let n = 0
      for (const name of sourceNames) n += this.db.run('UPDATE data_sources SET group_id = ? WHERE name = ?', id, name).changes
      return n
    })
  }

  /** 批量授权：把组内所有源按同一个额度授给某套餐（"限额即授权"的批量入口） */
  applyLimits(id: number, planId: number, limit: number): number {
    const members = this.db.all<{ name: string }>('SELECT name FROM data_sources WHERE group_id = ?', id)
    for (const m of members) this.quota.grant(planId, 'source', m.name, limit)
    return members.length
  }

  /** 未分组（或所属组已停用）的源数：分组只是视图，不是准入开关 */
  ungroupedCount(): number {
    return (
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM data_sources d
          WHERE d.group_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM source_groups g WHERE g.id = d.group_id AND g.status = 1)`,
      )?.n ?? 0
    )
  }

  /** 首页分节：只出**本次可见源里**至少有一个成员的组 */
  sections(): Array<{ id: number; name: string; sort_order: number; count: number }> {
    return this.db.all(
      `SELECT g.id, g.name, g.sort_order, COUNT(d.id) AS count
         FROM source_groups g JOIN data_sources d ON d.group_id = g.id
        WHERE g.status = 1 GROUP BY g.id ORDER BY g.sort_order, g.id`,
    ) as Array<{ id: number; name: string; sort_order: number; count: number }>
  }
}
