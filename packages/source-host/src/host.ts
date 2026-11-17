// 插件宿主：目录扫描 → manifest 校验 → import() → 声明落地 → 原子换代 → 老代 drain。
// in-process 模型下**代码不会被回收**，所以换代只是换注册表指针（迁移-TS-4 §2/§4）。
import { pathToFileURL } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SDK_VERSION, type PluginManifest } from '@loomproxy/contract'
import type { Logger, Upstream } from '@loomproxy/kernel'
import {
  SourceRegistry,
  createFetchFacade,
  type RegisteredSource,
  type SettingsReader,
  type SourceDefinition,
} from '@loomproxy/source-kit'
import type { DataSourceStore, SettingsStore } from '@loomproxy/store'
import { compareVersion, describeVersion, listVersions, sdkCompatible } from './manifest.ts'

export type PoolSink = {
  register(name: string, entry: { provider: import('@loomproxy/contract').PoolProvider; config?: Partial<import('@loomproxy/contract').PoolConfig> }): unknown
  unregister(name: string): Promise<void>
}

export type HostDeps = {
  pluginDir: string
  /** 池注册表（可选）：源声明了 pool 就登记进去，装配层负责启停 */
  pools?: PoolSink
  logger: Logger
  registry: SourceRegistry
  settings: SettingsStore
  dataSources: DataSourceStore
  upstream: Upstream
  /** 换代后等在飞请求结束的上限（默认 30s，与 systemd TimeoutStopSec 同量级） */
  drainTimeoutMs?: number
}

export type PluginInfo = {
  code: string
  version: string
  state: RegisteredSource['state']
  isolation: string
  generation: number
  inflight: number
  dir: string
  last_error?: string
}

type Loaded = { code: string; version: string; dir: string; entry: string; manifest: PluginManifest }

const SDK_MAJOR = Number(SDK_VERSION.split('.')[0] ?? 1)

export class SourceHost {
  private readonly registry: SourceRegistry
  private readonly versions = new Map<string, string[]>()
  /** 每个 code 当前指向第几个版本（回滚就是下标 -1） */
  private readonly cursor = new Map<string, number>()
  private readonly loaded = new Map<string, Loaded>()
  private readonly failures = new Map<string, string>()
  private readonly inflight = new Map<string, number>()
  private readonly drainWaiters = new Map<string, (() => void)[]>()
  private readonly fetch: ReturnType<typeof createFetchFacade>
  private readonly deps: HostDeps

  constructor(deps: HostDeps) {
    this.deps = deps
    this.registry = deps.registry
    this.fetch = createFetchFacade(deps.upstream)
  }

  // ---------- 扫描与加载 ----------

  /** 启动期扫描：每个 code 加载最新版本，失败只记错、不阻断其它插件 */
  scan(): PluginInfo[] {
    if (!existsSync(this.deps.pluginDir)) {
      this.deps.logger.warn(`插件目录不存在，跳过扫描: ${this.deps.pluginDir}`)
      return []
    }
    const codes = readdirSync(this.deps.pluginDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    for (const code of codes) {
      const dir = join(this.deps.pluginDir, code)
      const vers = listVersions(dir)
      if (vers.length === 0) {
        this.failures.set(code, `目录 ${dir} 下没有版本目录`)
        continue
      }
      this.versions.set(code, vers)
      this.cursor.set(code, vers.length - 1)
      const latest = vers[vers.length - 1] as string
      // 单个插件失败不拖垮启动
      void this.loadVersion(code, latest).catch((e: unknown) => {
        this.recordFailure(code, e)
        this.deps.logger.error(`加载插件 ${code}@${latest} 失败: ${errText(e)}`)
      })
    }
    return this.info()
  }

  /** 同步版扫描（测试与需要确定性的装配路径用） */
  async scanSync(): Promise<PluginInfo[]> {
    const codes = existsSync(this.deps.pluginDir)
      ? readdirSync(this.deps.pluginDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort()
      : []
    for (const code of codes) {
      const dir = join(this.deps.pluginDir, code)
      const vers = listVersions(dir)
      if (vers.length === 0) {
        this.failures.set(code, `目录 ${dir} 下没有版本目录`)
        continue
      }
      this.versions.set(code, vers)
      this.cursor.set(code, vers.length - 1)
        try {
        await this.loadVersion(code, vers[vers.length - 1] as string)
      } catch (e) {
        this.recordFailure(code, e)
        this.deps.logger.error(`加载插件 ${code} 失败: ${errText(e)}`)
      }
    }
    return this.info()
  }

  /** 一号插件换代：manifest 校验 → import → 声明落地 → 原子替换 → 老代 drain */
  async reload(code: string): Promise<PluginInfo> {
    const dir = join(this.deps.pluginDir, code)
    const vers = listVersions(dir)
    if (vers.length === 0) throw new Error(`插件 ${code} 没有可用版本`)
    this.versions.set(code, vers)
    // reload 永远指向最新版本（回滚是独立动作，不受它影响）。
    // 指针只在加载成功后前移：失败时候"当前版本"仍是老代。
    try {
      await this.loadVersion(code, vers[vers.length - 1] as string)
    } catch (e) {
      this.recordFailure(code, e)
      throw e
    }
    this.cursor.set(code, vers.length - 1)
    return this.mustInfo(code)
  }

  /** 回滚到上一个版本目录（产物本来就在盘上，不用重新打包） */
  async rollback(code: string): Promise<PluginInfo> {
    const vers = this.versions.get(code) ?? []
    const cur = this.cursor.get(code) ?? vers.length - 1
    const next = cur - 1
    if (next < 0) throw new Error(`插件 ${code} 没有更早的版本可回滚`)
    try {
      await this.loadVersion(code, vers[next] as string)
    } catch (e) {
      this.recordFailure(code, e)
      throw e
    }
    this.cursor.set(code, next)
    return this.mustInfo(code)
  }

  private async loadVersion(code: string, version: string): Promise<void> {
    const desc = describeVersion(join(this.deps.pluginDir, code), version)

    if (desc.manifest.meta.code !== code) {
      throw new Error(`manifest.meta.code=${desc.manifest.meta.code} 与目录名 ${code} 不一致`)
    }
    if (!sdkCompatible(desc.manifest.sdk_version, SDK_MAJOR)) {
      throw new Error(`sdk_version=${desc.manifest.sdk_version} 与宿主 ${SDK_VERSION} 不兼容`)
    }

    // 缓存破坏导入：in-process 模型下这是"换代"的唯一手段
    const url = `${pathToFileURL(desc.entry).href}?v=${encodeURIComponent(version)}-${Date.now()}`
    const mod = (await import(url)) as { default?: SourceDefinition }
    const def = mod.default
    if (!def || typeof def !== 'object' || !def.handlers) {
      throw new Error('插件入口必须 export default defineSource({...})')
    }

    // 声明的动作必须有 handler（否则运行期 404，属"带病装配"）
    for (const action of desc.manifest.meta.actions) {
      if (typeof def.handlers[action as keyof typeof def.handlers] !== 'function') {
        throw new Error(`manifest 声明了动作 ${action}，但入口没有对应 handler`)
      }
    }

    // 声明落地：幂等（不覆盖管理员改过的值与 status）
    this.deps.settings.register(desc.manifest.meta.settings ?? [])
    this.deps.dataSources.upsert(desc.manifest.meta)
    if (def.onBoot) {
      await def.onBoot({ settings: this.deps.settings, log: (m) => this.deps.logger.info(`onBoot: ${m}`) })
    }

    const prev = this.registry.get(code)
    this.deps.registry.swap({
      code,
      meta: desc.manifest.meta,
      version,
      isolation: desc.manifest.isolation,
      state: 'active',
      ...(desc.manifest.params ? { params: desc.manifest.params } : {}),
      def,
    })
    // 池声明：登记到装配层的注册表（源包不认识宿主，只声明；启停由 compose/main 做）
    if (def.pool) {
      if (!this.deps.pools) throw new Error('源声明了 pool，但装配层没有提供池注册表')
      this.deps.pools.register(def.pool.name, {
        provider: def.pool.provider,
        ...(def.pool.config ? { config: def.pool.config } : {}),
      })
    }
    this.loaded.set(code, { code, version, dir: desc.dir, entry: desc.entry, manifest: desc.manifest })
    this.failures.delete(code)
    this.deps.logger.info(`插件 ${code}@${version} 已生效（generation=${this.registry.generation}）`)

    // 老代 drain：等它身上的在飞请求走完，再调 dispose
    if (prev && prev.version !== version) {
      await this.drain(code)
      if (prev.def.dispose) {
        try {
          await prev.def.dispose()
        } catch (e) {
          this.deps.logger.warn(`插件 ${code}@${prev.version} dispose 失败: ${errText(e)}`)
        }
      }
    }
  }

  /** 失败只记错：已经 active 的老代保持服务（"坏版本不顶掉老代"） */
  private recordFailure(code: string, e: unknown): void {
    const msg = errText(e)
    this.failures.set(code, msg)
    const cur = this.registry.get(code)
    if (cur && cur.state === 'active') {
      cur.lastError = msg
      return
    }
    this.registry.markFailed(code, msg)
  }

  // ---------- 在飞请求计数（换代的原子性靠它兜住） ----------

  begin(code: string): void {
    this.inflight.set(code, (this.inflight.get(code) ?? 0) + 1)
  }

  end(code: string): void {
    const n = (this.inflight.get(code) ?? 1) - 1
    if (n <= 0) {
      this.inflight.delete(code)
      const waiters = this.drainWaiters.get(code) ?? []
      this.drainWaiters.delete(code)
      for (const w of waiters) w()
      return
    }
    this.inflight.set(code, n)
  }

  private drain(code: string): Promise<void> {
    if ((this.inflight.get(code) ?? 0) === 0) return Promise.resolve()
    const timeout = this.deps.drainTimeoutMs ?? 30_000
    return new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.deps.logger.warn(`插件 ${code} drain 超时（在飞 ${this.inflight.get(code) ?? 0}），继续换代`)
        finish()
      }, timeout)
      timer.unref?.()
      const list = this.drainWaiters.get(code) ?? []
      list.push(finish)
      this.drainWaiters.set(code, list)
    })
  }

  // ---------- 下线 ----------

  disable(code: string): void {
    this.registry.setState(code, 'disabled')
  }

  /** 卸载：摘注册表（等价 Go 版"摘导入 + 重启"，但不用重启） */
  async unload(code: string): Promise<void> {
    const cur = this.registry.get(code)
    const poolName = cur?.def.pool?.name
    this.registry.remove(code)
    if (poolName) await this.deps.pools?.unregister(poolName)
    if (cur?.def.dispose) await cur.def.dispose()
    this.failures.delete(code)
  }

  // ---------- 查询 ----------

  info(): PluginInfo[] {
    return this.registry.list().map((e) => {
      const loaded = this.loaded.get(e.code)
      return {
        code: e.code,
        version: loaded?.version ?? e.version,
        state: e.state,
        isolation: e.isolation,
        generation: e.generation,
        inflight: this.inflight.get(e.code) ?? 0,
        dir: loaded?.dir ?? '',
        ...(this.failures.get(e.code) ? { last_error: this.failures.get(e.code) as string } : {}),
        ...(e.lastError ? { last_error: e.lastError } : {}),
      }
    })
  }

  private mustInfo(code: string): PluginInfo {
    const found = this.info().find((i) => i.code === code)
    if (!found) throw new Error(`插件 ${code} 未加载`)
    return found
  }

  /** 供 api 使用：取当前代的 handler 与上下文依赖 */
  get registryRef(): SourceRegistry {
    return this.registry
  }

  fetchFacade(): typeof this.fetch {
    return this.fetch
  }

  settingsReader(): SettingsReader {
    return this.deps.settings
  }

  latestVersions(): Record<string, string[]> {
    return Object.fromEntries([...this.versions.entries()].map(([k, v]) => [k, [...v].sort(compareVersion)]))
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
