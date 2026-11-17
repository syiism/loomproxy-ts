// 号池形状（迁移-TS-2 §7）：框架不认识上游协议，只认"周期内可领次数/已领次数/到期时间"。
export const POOL_STATUS = ['hot', 'cold', 'spent', 'dead', 'cooldown'] as const
export type PoolStatus = (typeof POOL_STATUS)[number]

export const POOL_KINDS = ['burn_wall_clock', 'spread'] as const
export type PoolKind = '' | (typeof POOL_KINDS)[number]

export type Quota = { total: number; used: number; expiresAt?: Date }

export function exhausted(q: Quota): boolean {
  return q.used >= q.total
}

export function remaining(q: Quota): number {
  return q.expiresAt ? q.expiresAt.getTime() - Date.now() : 0
}

export type Device = {
  ident: string
  attrs: Record<string, string>
  /** 嵌套凭证载荷（框架不认识内容，快照只列第一层键名） */
  payload?: unknown
  quota: Quota
}

export type PoolConfig = {
  coldSpares: number
  maxHot: number
  maxDead: number
  maxDevices: number
  kind: PoolKind
  targetDevices: number
  cooldownDefaultMs: number
  renewBeforeMs: number
  intervalMs: number
  hookTimeoutMs: number
}

export type DeviceInfo = {
  ident: string
  /** 凭证字段名（只列键名，不列值——它们是上游签名凭证） */
  creds?: string[]
  payload_keys?: string[]
  status: PoolStatus
  note?: string
  total_quota: number
  used_quota: number
  expire_at: string | null
}

export type PoolStatusSnapshot = {
  name: string
  running: boolean
  config: Record<string, unknown>
  counts: Record<string, number>
  devices: DeviceInfo[]
  soft_deleted: number
}

/** 业务侧适配：三钩子。Claim 必须叠加无损（多次领取延长有效期而非重置）。 */
export type PoolProvider = {
  name(): string
  create(signal: AbortSignal): Promise<Device>
  refresh(signal: AbortSignal, dev: Device): Promise<Quota>
  claim(signal: AbortSignal, dev: Device): Promise<void>
  isResourceExpired?(err: unknown): boolean
}

/**
 * 设备持久化端口（**声明在契约层**，实现留在 store）：
 * 池运行时与持久化互不认识对方的包，只认识这张形状——这就是"单向依赖"在号码池上的落点。
 */
export type PoolDeviceRow = {
  ident: string
  attrs: Record<string, string>
  payload?: unknown
  status: PoolStatus
  total_quota: number
  used_quota: number
  expire_at: string | null
  note?: string
  created_at: string
  updated_at: string
}

export interface DeviceStore {
  /** 载入某池的全部号（含 spent/dead，运行期按状态决定用不用） */
  load(pool: string): PoolDeviceRow[]
  /** 全量落一行（ident 唯一） */
  save(pool: string, row: PoolDeviceRow): void
  /** 只更新状态/额度/备注（热路径，避免整行重写） */
  update(pool: string, ident: string, patch: Partial<Pick<PoolDeviceRow, 'status' | 'total_quota' | 'used_quota' | 'expire_at' | 'note'>>): void
  remove(pool: string, ident: string): void
}
