// 设置项：声明位登记 + 只写不回显（迁移-TS-2 §2 / §6）。
// 当前实现是内存 + JSON 文件（初始切片）；换成 drizzle/sqlite 时**只换实现，接口不变**——
// 这一层是 kernel(原语) 与 gate/api 之间唯一允许碰持久化的边界。
import type { SettingDecl, SettingType, SourceMeta } from '@loomproxy/contract'
import { isValidSettingType } from '@loomproxy/contract'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type SettingRow = { key: string; value: string; type: SettingType }

export interface SettingsStore {
  register(decls: SettingDecl[]): void
  get(key: string): string
  getBool(key: string, def: boolean): boolean
  getInt(key: string, def: number): number
  set(key: string, value: string): void
  /** 面板视角：**敏感键的值被抹成空串**（只写不回显） */
  list(): SettingRow[]
  /** 消费方视角：全部键值，含敏感键真值（worker 快照与本进程内的源都靠它读自己的密钥） */
  rawValues?(): Record<string, string>
  /** 敏感键：读接口回空串，写侧留空 = 保持原值 */
  sensitiveKeys(): string[]
}

type Options = { filePath?: string }

export class InMemorySettings implements SettingsStore {
  private readonly rows = new Map<string, { value: string; type: SettingType }>()
  private readonly sensitive = new Set<string>()
  private readonly filePath?: string

  constructor(opts: Options = {}) {
    if (opts.filePath) this.filePath = opts.filePath
    if (this.filePath) this.load()
  }

  private load(): void {
    if (!this.filePath) return
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as SettingRow[]
      for (const r of raw) {
        if (!isValidSettingType(r.type)) continue
        this.rows.set(r.key, { value: r.value, type: r.type })
      }
    } catch {
      // 文件不存在/损坏 → 从空开始（与 Go 版"行不存在才播种"同口径，不阻断启动）
    }
  }

  private persist(): void {
    if (!this.filePath) return
    mkdirSync(dirname(this.filePath), { recursive: true })
    const rows: SettingRow[] = [...this.rows.entries()].map(([key, v]) => ({ key, value: v.value, type: v.type }))
    writeFileSync(this.filePath, JSON.stringify(rows, null, 2), 'utf8')
  }

  /** 幂等：行不存在才插；存在只对账 type，**不覆盖管理员已填的值** */
  register(decls: SettingDecl[]): void {
    for (const d of decls) {
      if (!isValidSettingType(d.type)) throw new Error(`设置项 ${d.key} 的 type 非法: ${d.type}`)
      const cur = this.rows.get(d.key)
      if (cur) {
        cur.type = d.type
      } else {
        this.rows.set(d.key, { value: d.default, type: d.type })
      }
      if (d.sensitive) this.sensitive.add(d.key)
    }
    this.persist()
  }

  /** 数据源声明位里的 settings 一次性登记（热加载时重复调用也安全） */
  registerSourceDecls(metas: SourceMeta[]): void {
    for (const m of metas) this.register(m.settings ?? [])
  }

  /** 消费方视角：敏感键也返回真值——「只写不回显」约束的是 list()/面板，不是自己的消费方 */
  get(key: string): string {
    return this.rows.get(key)?.value ?? ''
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

  /** 敏感键留空 = 保持原值（面板的"不改就不填"） */
  set(key: string, value: string): void {
    const cur = this.rows.get(key)
    if (!cur) throw new Error(`设置项 ${key} 未注册，拒绝写入`)
    if (this.sensitive.has(key) && value === '') return
    cur.value = value
    this.persist()
  }

  list(): SettingRow[] {
    return [...this.rows.entries()].map(([key, v]) => ({
      key,
      value: this.sensitive.has(key) ? '' : v.value,
      type: v.type,
    }))
  }

  rawValues(): Record<string, string> {
    return Object.fromEntries([...this.rows.entries()].map(([k, v]) => [k, v.value]))
  }

  sensitiveKeys(): string[] {
    return [...this.sensitive]
  }
}
