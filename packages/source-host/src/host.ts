// 插件宿主：目录扫描 → manifest 校验 → import() → 声明落地 → 原子换代 → 老代 drain。
// in-process 模型下**代码不会被回收**，所以换代只是换注册表指针（迁移-TS-4 §2/§4）。
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { SDK_VERSION, parseSourceMeta, type PluginManifest } from '@loomproxy/contract'
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
import { WorkerPluginHost } from './worker-host.ts'
import { readZip } from './zip.ts'

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
  /**
   * 一个插件版本**生效后**的声明落地钩子（装配层用：登记接口成本行、未来的数据文件核对）。
   * 必须幂等：reload/回滚/重装都会再走一次。放在 host 之外，是因为"计费"是平台语义，
   * 宿主不该知道成本是什么（否则 source-host 就依赖了额度域）。
   */
  onPluginActive?: (meta: import('@loomproxy/contract').SourceMeta) => void
}

/** 一次「上传/粘贴安装」的入参：文件内容直接给，不落临时压缩包（省一个解压依赖与一层路径穿越风险） */
export type InstallInput = {
  code: string
  version: string
  /** 相对插件版本目录的文件路径 → 文件内容（文本）。必须含 manifest.json 与 manifest.entry 指向的入口 */
  files: Record<string, string>
}

/** 目录名/源码只允许小写字母数字下划线（与 manifest 的 code 约束一致）；版本号禁 `/` 与 `..` */
const CODE_RE = /^[a-z0-9_]+$/
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*$/

/**
 * 把用户给的文件路径收进版本目录内：拒绝绝对路径与 `..`，`./x` 与 `x` 同义。
 * 上传入口是**管理员**，但仍然要挡——一次路径穿越就是任意文件写。
 */
function safeRelPath(raw: string): string {
  const rel = normalize(raw.replace(/^\.\//, '')).replace(/^\.\//, '')
  if (rel === '' || rel.startsWith('..') || rel.startsWith('/') || rel.includes(`..${sep}`)) {
    throw new Error(`非法文件路径：${raw}`)
  }
  return rel
}

export type PluginInfo = {
  code: string
  version: string
  state: RegisteredSource['state']
  isolation: string
  /** **全局**换代序号（registry 的单调计数）：唯一标识"第几次加载"，不是"这个源加载过几次" */
  generation: number
  /** 这个 code 本进程内成功加载的次数（reload/回滚/重装都算）——与上一格分开，避免误读 */
  loads: number
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
  /** worker 隔离模式下的插件句柄（in-process 的插件不在这张表里） */
  private readonly workers = new Map<string, WorkerPluginHost>()
  /** 每个 code 的**成功加载次数**（展示用；generation 是全局限代序号，两件事别混） */
  private readonly loadCounts = new Map<string, number>()
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
          // 点目录是安装暂存区（.staging-xxxx），不是插件；扫进来只会多一条 failed 记录
          .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
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

  /**
   * 安装一个插件版本：校验 → 写盘（暂存目录 + 原子 rename）→ 立即换代。
   *
   * 三条纪律：
   * ① **码与版本号都过白名单**再拼路径：`code=../x` 或 `version=../../etc` 就是任意文件写；
   * ② 先写 `.staging-*` 再 rename：watcher 与扫描只认最终形态，不会捞到写了一半的版本；
   * ③ 同名版本目录**已存在就拒绝**（不覆盖正在跑的产物），换版本请给新号。
   *
   * 注意：安装插件 = 允许在进程内执行任意代码，这是管理员的权力，不是普通调用方的。
   */
  async install(input: InstallInput): Promise<PluginInfo> {
    if (!CODE_RE.test(input.code)) throw new Error(`源码只允许小写字母/数字/下划线：${input.code}`)
    if (!VERSION_RE.test(input.version)) throw new Error(`版本号非法（不许含 / 或以 . 开头）：${input.version}`)

    const files = Object.entries(input.files ?? {})
    if (files.length === 0) throw new Error('没有文件内容')
    const manifestRaw = input.files['manifest.json']
    if (manifestRaw === undefined) throw new Error('缺少 manifest.json')
    let manifest: PluginManifest
    try {
      manifest = JSON.parse(manifestRaw) as PluginManifest
    } catch (e) {
      throw new Error(`manifest.json 不是合法 JSON：${errText(e)}`)
    }
    // 声明位校验走与扫描同一条（zod）：非法 media_type/setting type/空 actions 在这里就失败，
    // 不要等写进盘里再由 scan 记 failed
    parseSourceMeta(manifest.meta)
    if (manifest.meta.code !== input.code) {
      throw new Error(`manifest.meta.code=${manifest.meta.code} 与提交的源码 ${input.code} 不一致`)
    }
    const entryRel = safeRelPath(String(manifest.entry ?? './index.mjs'))
    if (input.files[entryRel] === undefined) throw new Error(`入口文件 ${entryRel} 不在提交的内容里`)

    return this.writeAndActivate(input.code, input.version, input.files)
  }

  /**
   * 安装一个**插件包**（zip）：`manifest.json` 可以在包根，也可以带 `<code>/<version>/` 前缀
   * （`zip -r` 打包 plugin 目录的产物就是这个形状，不用运维手工拆一层路径）。
   * 版本号优先取请求给的，其次取前缀目录名，都没有就报错让调用方明说。
   */
  async installPackage(input: { bytes: Uint8Array; version?: string }): Promise<PluginInfo> {
    const entries = readZip(input.bytes)
    // 找 manifest.json：必须恰好一份（多份说明包里塞了两个源）
    const manifests = [...entries.keys()].filter((n) => n === 'manifest.json' || n.endsWith('/manifest.json'))
    if (manifests.length === 0) throw new Error('包里没有 manifest.json')
    if (manifests.length > 1) throw new Error(`包里有多份 manifest.json（${manifests.join(', ')}），一次只装一个源`)
    const manifestPath = manifests[0] as string
    const root = manifestPath.slice(0, -'manifest.json'.length).replace(/\/$/, '')

    // 只收 root 之下的文件；包根上散落的其他东西（README/截图）忽略但不允许出现第二个根
    const files: Record<string, string> = {}
    for (const [name, content] of entries) {
      if (root !== '' && !name.startsWith(`${root}/`)) continue
      const rel = safeRelPath(root === '' ? name : name.slice(root.length + 1))
      files[rel] = new TextDecoder().decode(content)
    }
    const manifestRaw = files['manifest.json']
    if (manifestRaw === undefined) throw new Error('包里没有 manifest.json')
    let manifest: PluginManifest
    try {
      manifest = JSON.parse(manifestRaw) as PluginManifest
    } catch (e) {
      throw new Error(`manifest.json 不是合法 JSON：${errText(e)}`)
    }
    const code = String(manifest.meta?.code ?? '')
    if (!CODE_RE.test(code)) {
      throw new Error(`manifest.meta.code 缺失或非法（只允许小写字母/数字/下划线）：${code}`)
    }
    // 前缀 `<code>/<version>` 时顺手把版本号带出来（少于两段就只可能是 <code>）
    const segs = root.split('/').filter(Boolean)
    const fromPath = segs.length >= 2 ? (segs[segs.length - 1] as string) : ''
    const version = input.version ?? (VERSION_RE.test(fromPath) ? fromPath : '')
    if (!version) throw new Error('包里没有带版本号目录，请在请求里给 version')
    return this.install({ code, version, files })
  }

  /** 写盘（暂存 + 原子 rename）然后换代；失败时按"有没有老代"决定留不留新目录 */
  private async writeAndActivate(code: string, version: string, files: Record<string, string>): Promise<PluginInfo> {
    const codeDir = join(this.deps.pluginDir, code)
    const target = join(codeDir, version)
    if (existsSync(target)) throw new Error(`版本 ${code}@${version} 已存在（换一个版本号，或先卸载）`)

    mkdirSync(this.deps.pluginDir, { recursive: true })
    const staging = join(this.deps.pluginDir, `.staging-${randomBytes(6).toString('hex')}`)
    try {
      for (const [rawPath, content] of Object.entries(files)) {
        const rel = safeRelPath(rawPath)
        const abs = join(staging, rel)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content)
      }
      mkdirSync(codeDir, { recursive: true })
      renameSync(staging, target)
    } catch (e) {
      rmSync(staging, { recursive: true, force: true })
      throw e
    }

    // 换代失败：老代还在跑就保留新目录（供排查/回滚），没有老代就清掉——
    // 否则下一次扫描会把一个带病的版本当成"当前版本"，每次启动都报同一条错
    const hadGeneration = this.loaded.has(code)
    try {
      return await this.reload(code)
    } catch (e) {
      if (!hadGeneration) {
        rmSync(target, { recursive: true, force: true })
        this.versions.delete(code)
      }
      throw e
    }
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

    // worker 隔离模式（④ §2）：插件跑在独立线程里，取数/设置/池仍回主线程执行。
    // 线程的好处是真能卸载（in-process 换代码只是换指针，老模块回收不掉）。
    if (desc.manifest.isolation === 'worker') {
      const prevWorker = this.workers.get(code)
      if (prevWorker) {
        await prevWorker.drain()
        await prevWorker.terminate()
        this.workers.delete(code)
      }
      this.deps.settings.register(desc.manifest.meta.settings ?? [])
      this.deps.dataSources.upsert(desc.manifest.meta)
      this.deps.onPluginActive?.(desc.manifest.meta)
      const worker = new WorkerPluginHost({
        code,
        entry: desc.entry,
        version,
        actions: desc.manifest.meta.actions,
        logger: this.deps.logger,
        upstream: this.deps.upstream,
        settings: this.deps.settings as unknown as {
          get(key: string): string
          list(): Array<{ key: string; value: string }>
        },
        ...(this.deps.pools ? { pools: this.deps.pools as never } : {}),
      })
      this.workers.set(code, worker)
      this.deps.registry.swap({
        code,
        meta: desc.manifest.meta,
        version,
        isolation: desc.manifest.isolation,
        state: 'active',
        ...(desc.manifest.params ? { params: desc.manifest.params } : {}),
        def: { handlers: {} },
        invoke: (action, params) => worker.call(action, params),
      })
      this.loaded.set(code, { code, version, dir: desc.dir, entry: desc.entry, manifest: desc.manifest })
      this.failures.delete(code)
      this.loadCounts.set(code, (this.loadCounts.get(code) ?? 0) + 1)
      this.deps.logger.info(`插件 ${code}@${version} 已生效（worker 隔离，generation=${this.registry.generation}）`)
      return
    }

    // 声明落地：幂等（不覆盖管理员改过的值与 status）
    this.deps.settings.register(desc.manifest.meta.settings ?? [])
    this.deps.dataSources.upsert(desc.manifest.meta)
    this.deps.onPluginActive?.(desc.manifest.meta)
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
    this.loadCounts.set(code, (this.loadCounts.get(code) ?? 0) + 1)
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
    const worker = this.workers.get(code)
    if (worker) {
      await worker.drain()
      await worker.terminate()
      this.workers.delete(code)
    }
    this.registry.remove(code)
    if (poolName) await this.deps.pools?.unregister(poolName)
    if (cur?.def.dispose) await cur.def.dispose()
    this.failures.delete(code)
    // 重新装回来从 0 数：跨两次安装累加的"加载次数"更费解
    this.loadCounts.delete(code)
  }

  /** 停机/测试收尾：把所有 worker 插件停掉（in-process 的没有线程要收） */
  async dispose(): Promise<void> {
    for (const [code, worker] of this.workers) {
      await worker.drain(2_000)
      await worker.terminate()
      this.workers.delete(code)
    }
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
        loads: this.loadCounts.get(e.code) ?? 0,
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
