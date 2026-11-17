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
