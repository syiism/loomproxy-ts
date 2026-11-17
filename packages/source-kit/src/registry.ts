// 注册表：**每次请求现取**，不许在路由注册期闭包捕获——否则换代后老代码还在服务
// （迁移-TS-4 §2 的唯一硬约束）。
import type { ActionName, SourceMeta } from '@loomproxy/contract'
import type { SourceDefinition } from './handler.ts'

export type SourceState = 'active' | 'failed' | 'disabled'

export type RegisteredSource = {
  code: string
  meta: SourceMeta
  version: string
  isolation: 'in-process' | 'worker'
  state: SourceState
  /** 这一代是第几次加载（诊断用；in-process 模型下老代码不会被回收） */
  generation: number
  lastError?: string
  /** 每个动作注入哪些 query（manifest.params；缺省用标准参数集，见 api/params.ts） */
  params?: Record<string, string[]>
  def: SourceDefinition
  /** worker 隔离模式的执行入口（in-process 模式下为 undefined，直接调 def.handlers） */
  invoke?: (action: ActionName, params: import('@loomproxy/contract').Params) => Promise<unknown>
}

export type Resolved = { entry: RegisteredSource; handler: NonNullable<SourceDefinition['handlers'][ActionName]> }

export class SourceRegistry {
  private readonly entries = new Map<string, RegisteredSource>()
  private generationSeq = 0

  /** 每次扫插件/换代都 +1；/datasources 缓存键必须并进它 */
  get generation(): number {
    return this.generationSeq
  }

  /** 原子替换：一次 Map.set，此前取走的 resoloved 继续用它自己那一代 */
  swap(entry: Omit<RegisteredSource, 'generation'>): RegisteredSource {
    const prev = this.entries.get(entry.code)
    const next: RegisteredSource = { ...entry, generation: ++this.generationSeq }
    if (prev) {
      // 覆盖即"新一代生效"；老代的 dispose 由调用方按 draining 时机执行
      this.entries.set(entry.code, next)
      return next
    }
    this.entries.set(entry.code, next)
    return next
  }

  markFailed(code: string, err: string): void {
    const cur = this.entries.get(code)
    if (cur) {
      cur.state = 'failed'
      cur.lastError = err
      return
    }
    // 从没加载成功过：留一条 failed 记录，供 /admin/sources/plugins 展示
    this.entries.set(code, {
      code,
      meta: { code, display: code, category: 'unknown', sort_order: 0, status: 0, actions: [], fixed_base_url: false },
      version: '-',
      isolation: 'in-process',
      state: 'failed',
      generation: ++this.generationSeq,
      lastError: err,
      def: { handlers: {} },
    })
  }

  setState(code: string, state: SourceState): void {
    const cur = this.entries.get(code)
    if (cur) cur.state = state
  }

  get(code: string): RegisteredSource | undefined {
    return this.entries.get(code)
  }

  /** 请求期解析：取一次即持有该代（保证在飞请求不受换代影响） */
  resolve(code: string, action: ActionName): Resolved | undefined {
    const entry = this.entries.get(code)
    if (!entry || entry.state !== 'active') return undefined
    const handler = entry.def.handlers[action]
    if (!handler && !entry.invoke) return undefined
    return { entry, handler: handler ?? (() => Promise.resolve(undefined)) }
  }

  list(): RegisteredSource[] {
    return [...this.entries.values()].sort(
      (a, b) => a.meta.sort_order - b.meta.sort_order || a.code.localeCompare(b.code),
    )
  }

  active(): RegisteredSource[] {
    return this.list().filter((e) => e.state === 'active')
  }

  remove(code: string): void {
    this.entries.delete(code)
    this.generationSeq++
  }
}
