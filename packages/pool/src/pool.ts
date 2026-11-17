// 通用「号池」运行时：与 Go 版 base/pool 同一套状态机，去掉 Go 那边的锁（单线程 + 内存态本身就够）。
//
// 框架只知道四件事：周期内可领次数、已领次数、资源到期时间、号现在能不能用。
// 「怎么建号 / 怎么查台账 / 怎么领取」由源的 Provider 提供（fq_novel 就是拿它做会话池）。
//
// 两种形态（Config.kind）：
//   · burn_wall_clock（默认）：资源按墙钟燃烧——框架定时 Refresh 台账、临期 Claim 续领、耗尽换号；
//   · spread（用量摊薄）：号不因时间失效，框架**不探活、不领取**，可用性由业务用 report()/cooldown() 上报。
import type {
  Device,
  DeviceInfo,
  DeviceStore,
  PoolConfig,
  PoolDeviceRow,
  PoolProvider,
  PoolStatus,
  PoolStatusSnapshot,
  Quota,
} from '@loomproxy/contract'
import { exhausted, remaining } from '@loomproxy/contract'
import type { Logger } from '@loomproxy/kernel'
import { nowIso } from './util.ts'

export const KIND_BURN_WALL_CLOCK = 'burn_wall_clock'
export const KIND_SPREAD = 'spread'

export const DEFAULT_CONFIG: PoolConfig = {
  coldSpares: 2,
  maxHot: 3,
  maxDead: 10,
  maxDevices: 0,
  kind: '',
  targetDevices: 0,
  cooldownDefaultMs: 10 * 60_000,
  renewBeforeMs: 5 * 60_000,
  intervalMs: 60_000,
  hookTimeoutMs: 30_000,
}

export type PoolEntry = { provider: PoolProvider; config?: Partial<PoolConfig> }

type Live = {
  ident: string
  row: PoolDeviceRow
}

/** 一次钩子调用必须带截止：不读信号的 Provider 拦不住一次挂住的上游 */
async function withDeadline<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  timer.unref?.()
  try {
    return await fn(ac.signal)
  } finally {
    clearTimeout(timer)
  }
}

export class Pool {
  readonly name: string
  private readonly provider: PoolProvider
  private readonly cfg: PoolConfig
  private readonly store: DeviceStore
  private readonly logger: Logger
  private hot: Live[] = []
  private cold: Live[] = []
  private spent: Live[] = []
  private dead: Live[] = []
  private cooldowns = new Map<string, { until: number; note: string }>()
  private cursor = 0
  private timer?: NodeJS.Timeout
  private running = false
  /** 连续失败计数（错误驱动扩容/退役的依据；成功一次就清零） */
  private fails = new Map<string, number>()

  constructor(input: { name: string; provider: PoolProvider; config: Partial<PoolConfig> | undefined; store: DeviceStore; logger: Logger }) {
    this.name = input.name
    this.provider = input.provider
    this.cfg = { ...DEFAULT_CONFIG, ...(input.config ?? {}) }
    this.store = input.store
    this.logger = input.logger.child(`pool:${input.name}`)
  }

  get kind(): string {
    return this.cfg.kind === KIND_SPREAD ? KIND_SPREAD : KIND_BURN_WALL_CLOCK
  }

  get isRunning(): boolean {
    return this.running
  }

  /** 启动：从库里装载；spread 型不探活（探活本身就是风控成本） */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    const rows = this.store.load(this.name)
    for (const row of rows) {
      const live: Live = { ident: row.ident, row }
      switch (row.status) {
        case 'hot':
          this.hot.push(live)
          break
        case 'cold':
          this.cold.push(live)
          break
        case 'dead':
          this.dead.push(live)
          break
        case 'cooldown':
          this.cooldowns.set(row.ident, { until: Date.now() + this.cfg.cooldownDefaultMs, note: row.note ?? '' })
          this.cold.push(live)
          break
        default:
          this.spent.push(live)
      }
    }
    this.logger.info(`载入 ${this.hot.length} 活跃 / ${this.cold.length} 冷备 / ${this.spent.length} 耗尽 / ${this.dead.length} 死号（kind=${this.kind}）`)
    await this.topUp()
    this.timer = setInterval(() => {
      void this.maintain().catch((e: unknown) => this.logger.error(`巡检失败: ${errText(e)}`))
    }, this.cfg.intervalMs)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  // ---------- 取号 ----------

  /** 取一个可用号；没有可用号时报错（调用方决定是带内错误还是 503） */
  async acquire(): Promise<Device> {
    if (this.kind === KIND_SPREAD) {
      // 摊薄型：全部可用号轮询。冷备第一次被选中时**转正为 hot**（不探活、不领取，
      // 只翻状态），此后与其它 hot 一起轮询；冷却过的号留在 hot 里，靠 cooldown 跳过。
      if (this.hot.length > 0) {
        for (let i = 0; i < this.hot.length; i++) {
          this.cursor = (this.cursor + 1) % this.hot.length
          const live = this.hot[this.cursor]!
          const cd = this.cooldowns.get(live.ident)
          if (!cd || cd.until <= Date.now()) return toDevice(live)
        }
      }
      const promoted = this.promoteSpread()
      if (promoted) return toDevice(promoted)
    } else {
      if (this.hot.length === 0) {
        const promoted = await this.promote()
        if (!promoted) throw new Error(`号池 ${this.name} 无可用号`)
        return toDevice(promoted)
      }
      this.cursor = (this.cursor + 1) % this.hot.length
      return toDevice(this.hot[this.cursor]!)
    }
    const promoted = await this.promote()
    if (!promoted) throw new Error(`号池 ${this.name} 无可用号`)
    return toDevice(promoted)
  }

  private pickSpread(): Live | undefined {
    const now = Date.now()
    for (const live of this.hot) {
      const cd = this.cooldowns.get(live.ident)
      if (!cd || cd.until <= now) return live
    }
    for (const live of this.cold) {
      const cd = this.cooldowns.get(live.ident)
      if (cd && cd.until > now) continue
      this.cooldowns.delete(live.ident)
      return live
    }
    return undefined
  }

  /** 摊薄型转正：只翻状态（不探活、不领取——探活本身就是风控成本） */
  private promoteSpread(): Live | undefined {
    const now = Date.now()
    while (this.cold.length > 0) {
      const live = this.cold.shift()!
      const cd = this.cooldowns.get(live.ident)
      if (cd && cd.until > now) {
        this.cold.push(live)
        continue
      }
      this.cooldowns.delete(live.ident)
      this.setStatus(live, 'hot')
      this.hot.push(live)
      this.cursor = this.hot.length - 1
      return live
    }
    return undefined
  }

  /** 冷备转正：墙钟型要先 Refresh + 临期 Claim；摊薄型只翻状态（不探活） */
  private async promote(): Promise<Live | undefined> {
    while (this.cold.length > 0) {
      const live = this.cold.shift()!
      if (this.kind !== KIND_SPREAD && this.provider.refresh) {
        try {
          const q = await withDeadline(this.cfg.hookTimeoutMs, (s) => this.provider.refresh(s, toDevice(live)))
          applyQuota(live, q)
          if (exhausted(q)) {
            this.markSpent(live)
            continue
          }
          if (remaining(q) <= this.cfg.renewBeforeMs ) {
            await withDeadline(this.cfg.hookTimeoutMs, (s) => this.provider.claim(s, toDevice(live)))
          }
        } catch (e) {
          this.logger.warn(`转正前刷新失败，判死: ${live.ident.slice(0, 8)} ${errText(e)}`)
          this.markDead(live)
          continue
        }
      }
      this.setStatus(live, 'hot')
      this.hot.push(live)
      this.cursor = 0
      this.logger.info(`转正 ${short(live.ident)}（活跃 ${this.hot.length}）`)
      return live
    }
    return undefined
  }

  // ---------- 业务反馈 ----------

  /** 上游成功的票：清掉失败计数（错误驱动扩容只看"连续失败"） */
  success(): void {
    this.fails.clear()
  }

  /**
   * 上游失败的票。spread 型进入冷却（不判死：风控通常按 IP/号维度短暂生效）；
   * 墙钟型连续失败达阈值后判死（资源真的坏了，留在池里只会继续拖慢）。
   */
  report(err: unknown): void {
    if (!err) {
      this.success()
      return
    }
    const expired = this.provider.isResourceExpired?.(err) ?? false
    for (const live of [...this.hot, ...this.cold]) {
      const n = (this.fails.get(live.ident) ?? 0) + 1
      this.fails.set(live.ident, n)
      if (this.kind === KIND_SPREAD) {
        // 风控类失败：号码进冷却（默认 10 分钟），不判死
        this.cooldown(live.ident, undefined, errText(err))
        return
      }
      if (expired) {
        void this.reauthorize(toDevice(live))
        return
      }
      if (n >= 3) this.markDead(live)
      return
    }
  }

  /** 业务侧主动冷却（spread 型的唯一可用性上报口） */
  cooldown(ident: string, until?: number, note = ''): void {
    const target = until ?? Date.now() + this.cfg.cooldownDefaultMs
    this.cooldowns.set(ident, { until: target, note })
    this.store.update(this.name, ident, { status: 'cooldown', note })
    this.logger.warn(`冷却 ${short(ident)} 至 ${new Date(target).toISOString()}${note ? `（${note}）` : ''}`)
  }

  /** 资源到期：补领（叠加无损）；补领失败判耗尽并转正下一个 */
  async reauthorize(dev: Device): Promise<Device | undefined> {
    const live = this.find(dev.ident)
    if (!live) return undefined
    try {
      await withDeadline(this.cfg.hookTimeoutMs, (s) => this.provider.claim(s, dev))
      this.setStatus(live, 'hot')
      this.logger.info(`补领成功 ${short(live.ident)}`)
      return toDevice(live)
    } catch (e) {
      this.logger.warn(`补领失败，判耗尽 ${short(live.ident)}: ${errText(e)}`)
      this.markSpent(live)
      const next = await this.promote()
      return next ? toDevice(next) : undefined
    }
  }

  // ---------- 维护 ----------

  /** 一拍：墙钟型刷台账/续期/回收；两种形态都要补冷备 */
  async maintain(): Promise<void> {
    if (this.kind !== KIND_SPREAD) {
      for (const live of [...this.hot]) {
        try {
          const q = await withDeadline(this.cfg.hookTimeoutMs, (s) => this.provider.refresh(s, toDevice(live)))
          applyQuota(live, q)
          if (exhausted(q)) {
            this.markSpent(live)
            continue
          }
          if (remaining(q) <= this.cfg.renewBeforeMs ) {
            await withDeadline(this.cfg.hookTimeoutMs, (s) => this.provider.claim(s, toDevice(live)))
          }
        } catch (e) {
          this.logger.warn(`刷新失败 ${short(live.ident)}: ${errText(e)}`)
        }
      }
      // 活跃号不够时从冷备补
      while (this.hot.length < 1 && this.cold.length > 0) {
        const promoted = await this.promote()
        if (!promoted) break
      }
    }
    this.expireCooldowns()
    this.trimDead()
    await this.topUp()
  }

  private expireCooldowns(): void {
    const now = Date.now()
    for (const [ident, cd] of this.cooldowns) {
      if (cd.until <= now) {
        this.cooldowns.delete(ident)
        const live = this.find(ident)
        if (live && live.row.status === 'cooldown') this.setStatus(live, 'cold')
      }
    }
  }

  /** 死号只留 MaxDead 条（物理删除，腾出建号名额） */
  private trimDead(): void {
    const max = this.cfg.maxDead
    while (this.dead.length > max) {
      const live = this.dead.shift()!
      this.store.remove(this.name, live.ident)
      this.logger.info(`清理死号 ${short(live.ident)}（保留上限 ${max}）`)
    }
  }

  /** 补冷备：新号由 Provider.Create 建（建号对上游是不可逆增长，所以有 MaxDevices 闸门） */
  private async topUp(): Promise<void> {
    const target = this.cfg.coldSpares
    while (this.cold.length < target) {
      const total = this.hot.length + this.cold.length + this.spent.length + this.dead.length
      if (this.cfg.maxDevices > 0 && total >= this.cfg.maxDevices) {
        this.logger.debug(`冷备补不满：已达总号上限 ${this.cfg.maxDevices}`)
        return
      }
      try {
        const dev = await withDeadline(this.cfg.hookTimeoutMs, (s) => this.provider.create(s))
        const row: PoolDeviceRow = {
          ident: dev.ident,
          attrs: dev.attrs,
          ...(dev.payload !== undefined ? { payload: dev.payload } : {}),
          status: 'cold',
          total_quota: dev.quota.total,
          used_quota: dev.quota.used,
          expire_at: dev.quota.expiresAt ? dev.quota.expiresAt.toISOString() : null,
          created_at: nowIso(),
          updated_at: nowIso(),
        }
        this.store.save(this.name, row)
        this.cold.push({ ident: row.ident, row })
        this.logger.info(`新建冷备 ${short(row.ident)}（冷备 ${this.cold.length}/${target}）`)
      } catch (e) {
        this.logger.warn(`建号失败: ${errText(e)}`)
        return
      }
    }
  }

  // ---------- 状态快照（/admin/pools） ----------

  status(): PoolStatusSnapshot {
    const counts: Record<string, number> = {
      hot: this.hot.length,
      cold: this.cold.length,
      cooldown: this.cooldowns.size,
      spent: this.spent.length,
      dead: this.dead.length,
    }
    const devices: DeviceInfo[] = [
      ...this.hot.map((l) => toInfo(l, this.cooldowns.get(l.ident)?.note)),
      ...this.cold.map((l) => toInfo(l, this.cooldowns.get(l.ident)?.note)),
      ...this.spent.map((l) => toInfo(l)),
      ...this.dead.map((l) => toInfo(l)),
    ]
    return {
      name: this.name,
      running: this.running,
      config: {
        cold_spares: this.cfg.coldSpares,
        max_hot: this.cfg.maxHot,
        max_dead: this.cfg.maxDead,
        max_devices: this.cfg.maxDevices,
        kind: this.kind === KIND_SPREAD ? KIND_SPREAD : '',
        renew_before_sec: Math.round(this.cfg.renewBeforeMs / 1000),
        maintain_sec: Math.round(this.cfg.intervalMs / 1000),
      },
      counts,
      devices,
      soft_deleted: 0,
    }
  }

  // ---------- 内部 ----------

  private find(ident: string): Live | undefined {
    return [...this.hot, ...this.cold, ...this.spent, ...this.dead].find((l) => l.ident === ident)
  }

  private detach(live: Live): void {
    this.hot = this.hot.filter((l) => l !== live)
    this.cold = this.cold.filter((l) => l !== live)
    this.spent = this.spent.filter((l) => l !== live)
    this.dead = this.dead.filter((l) => l !== live)
  }

  private setStatus(live: Live, status: PoolStatus): void {
    live.row.status = status
    live.row.updated_at = nowIso()
    this.store.update(this.name, live.ident, { status })
  }

  private markSpent(live: Live): void {
    this.detach(live)
    this.setStatus(live, 'spent')
    this.spent.push(live)
  }

  private markDead(live: Live): void {
    this.detach(live)
    this.setStatus(live, 'dead')
    this.dead.push(live)
    this.fails.delete(live.ident)
  }
}

function applyQuota(live: Live, q: Quota): void {
  live.row.total_quota = q.total
  live.row.used_quota = q.used
  live.row.expire_at = q.expiresAt ? q.expiresAt.toISOString() : null
  live.row.updated_at = nowIso()
}

function toDevice(live: Live): Device {
  const row = live.row
  return {
    ident: row.ident,
    attrs: row.attrs,
    ...(row.payload !== undefined ? { payload: row.payload } : {}),
    quota: {
      total: row.total_quota,
      used: row.used_quota,
      ...(row.expire_at ? { expiresAt: new Date(row.expire_at) } : {}),
    },
  }
}

/** 快照只列**键名**不列值：attrs/payload 是上游签名凭证 */
function toInfo(live: Live, note?: string): DeviceInfo {
  const row = live.row
  const payloadKeys =
    row.payload && typeof row.payload === 'object' ? Object.keys(row.payload as Record<string, unknown>) : []
  return {
    ident: row.ident,
    creds: Object.keys(row.attrs ?? {}),
    ...(payloadKeys.length ? { payload_keys: payloadKeys } : {}),
    status: row.status,
    ...(note ?? row.note ? { note: note ?? row.note } : {}),
    total_quota: row.total_quota,
    used_quota: row.used_quota,
    expire_at: row.expire_at,
  }
}

function short(ident: string): string {
  return ident.length > 8 ? ident.slice(0, 8) : ident
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
