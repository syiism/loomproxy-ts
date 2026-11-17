// 池注册表：源在加载时登记自己的池（manifest/defineSource 那一侧），装配层启动/停止。
// 名字唯一（通常取数据源码）；重复登记直接报错——两个池共用一个名字会让状态快照互相覆盖。
import type { DeviceStore, PoolProvider } from '@loomproxy/contract'
import type { Logger } from '@loomproxy/kernel'
import { Pool, type PoolEntry } from './pool.ts'

export type PoolRuntime = {
  register(name: string, entry: PoolEntry): Pool
  get(name: string): Pool | undefined
  all(): Pool[]
  unregister(name: string): Promise<void>
  startAll(): Promise<void>
  stopAll(): Promise<void>
  statusAll(): ReturnType<Pool['status']>[]
}

export function createPoolRuntime(deps: { store: DeviceStore; logger: Logger; enabled?: boolean }): PoolRuntime {
  const pools = new Map<string, Pool>()
  const enabled = deps.enabled ?? true

  return {
    register(name, entry) {
      if (pools.has(name)) throw new Error(`池 ${name} 重复登记`)
      const pool = new Pool({ name, provider: entry.provider, config: entry.config, store: deps.store, logger: deps.logger })
      pools.set(name, pool)
      if (!enabled) deps.logger.info(`池 ${name} 已登记但未启动（POOL_ENABLED=false）`)
      return pool
    },
    get: (name) => pools.get(name),
    all: () => [...pools.values()],
    async unregister(name) {
      const pool = pools.get(name)
      if (!pool) return
      await pool.stop()
      pools.delete(name)
    },
    async startAll() {
      if (!enabled) return
      for (const pool of pools.values()) await pool.start()
    },
    async stopAll() {
      for (const pool of pools.values()) await pool.stop()
    },
    statusAll: () => [...pools.values()].map((p) => p.status()),
  }
}

export type { PoolProvider, DeviceStore }
