// data_sources 行 + 按套餐裁剪的视图。真实实现走 drizzle（迁移-TS-3 §6），
// 接口先定下来：api/catalog 读它，插件登记时 upsert 它。
import type { SourceMeta } from '@loomproxy/contract'

export type DataSourceRow = {
  /** 行 id（内存实现不带；DB 行带） */
  id?: number
  description?: string
  name: string
  display_name: string
  category: string
  sort_order: number
  status: number
  /** 源声明的默认媒介 */
  media_type?: string
}

export interface DataSourceStore {
  upsert(meta: SourceMeta): void
  setStatus(name: string, status: number): void
  get(name: string): DataSourceRow | undefined
  /** 只列启用的，按 sort_order,id 升序 */
  listEnabled(): DataSourceRow[]
}

export class InMemoryDataSources implements DataSourceStore {
  private readonly rows = new Map<string, DataSourceRow>()

  /** 幂等 upsert：**不覆盖管理员改过的 status**（只有显式 setStatus 才改） */
  upsert(meta: SourceMeta): void {
    const cur = this.rows.get(meta.code)
    if (cur) {
      cur.display_name = meta.display
      cur.category = meta.category
      cur.sort_order = meta.sort_order
      cur.media_type = meta.media_type
      return
    }
    this.rows.set(meta.code, {
      name: meta.code,
      display_name: meta.display,
      category: meta.category,
      sort_order: meta.sort_order,
      status: meta.status,
      media_type: meta.media_type,
    })
  }

  setStatus(name: string, status: number): void {
    const row = this.rows.get(name)
    if (row) row.status = status
  }

  get(name: string): DataSourceRow | undefined {
    return this.rows.get(name)
  }

  listEnabled(): DataSourceRow[] {
    return [...this.rows.values()]
      .filter((r) => r.status === 1)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  }
}
