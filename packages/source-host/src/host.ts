// 插件宿主：目录扫描 → manifest 校验 → 内容指纹 → import() → 声明落地 → 原子换代 → 老代 drain。
// 指纹没变（active 源）就只重落幂等声明、不换代：watcher/手动/批量 reload 不再各自涨一代。
// in-process 模型下**代码不会被回收**，所以换代只是换注册表指针（迁移-TS-4 §2/§4）。
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { pluginManifestSchema, SDK_VERSION, type PluginManifest } from '@loomproxy/contract'
import type { Logger, Upstream } from '@loomproxy/kernel'
import {
  SourceRegistry,
  createFetchFacade,
  createPluginSdk,
  type PluginFactory,
  type RegisteredSource,
  type SettingsReader,
  type SourceDefinition,
} from '@loomproxy/source-kit'
import type { DataSourceStore, SettingsStore } from '@loomproxy/store'
import { describePlugin, sdkCompatible } from './manifest.ts'
import { pluginFingerprint } from './fingerprint.ts'
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
  /** 相对插件目录的文件路径 → 文件内容（文本）。必须含 manifest.json 与 manifest.entry 指向的入口 */
  files: Record<string, string>
}

/** 目录名/源码只允许小写字母数字下划线（与 manifest 的 code 约束一致） */
const CODE_RE = /^[a-z0-9_]+$/

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

type Loaded = { code: string; version: string; dir: string; entry: string; manifest: PluginManifest; fingerprint: string }

const SDK_MAJOR = Number(SDK_VERSION.split('.')[0] ?? 1)

/** 同一毫秒内两次 reload 不能撞到同一个 import URL，否则失败模块会被复用 */
let importSeq = 0

export class SourceHost {
  private readonly registry: SourceRegistry
  private readonly loaded = new Map<string, Loaded>()
  private readonly failures = new Map<string, string>()
  /** worker 隔离模式下的插件句柄（in-process 的插件不在这张表里） */
  private readonly workers = new Map<string, WorkerPluginHost>()
  /** 每个 code 的**成功加载次数**（展示用；generation 是全局限代序号，两件事别混） */
  private readonly loadCounts = new Map<string, number>()
  /** 同一个 code 的 reload 串行：watcher 与手动/批量 reload 会撞车，晚到的必须看到前一次写入的指纹 */
  private readonly reloadLocks = new Map<string, Promise<void>>()
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

  /** 启动期扫描：每个 code 只加载当前目录那一份，失败只记错、不阻断其它插件 */
  scan(): PluginInfo[] {
    if (!existsSync(this.deps.pluginDir)) {
      this.deps.logger.warn(`插件目录不存在，跳过扫描: ${this.deps.pluginDir}`)
      return []
    }
    const codes = this.codeDirs()
    for (const code of codes) {
      // 单个插件失败不拖垮启动
      void this.load(code).catch((e: unknown) => {
        this.recordFailure(code, e)
        this.deps.logger.error(`加载插件 ${code} 失败: ${errText(e)}`)
      })
    }
    return this.info()
  }

  /** 同步版扫描（测试与需要确定性的装配路径用） */
  async scanSync(): Promise<PluginInfo[]> {
    for (const code of this.codeDirs()) {
      try {
        await this.load(code)
      } catch (e) {
        this.recordFailure(code, e)
        this.deps.logger.error(`加载插件 ${code} 失败: ${errText(e)}`)
      }
    }
    return this.info()
  }

  private codeDirs(): string[] {
    if (!existsSync(this.deps.pluginDir)) return []
    return readdirSync(this.deps.pluginDir, { withFileTypes: true })
      // 点目录是安装暂存区（.staging-*/.backup-*），不是插件
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .filter((n) => CODE_RE.test(n))
      .sort()
  }

  private async serializeReload<T>(code: string, task: () => Promise<T>): Promise<T> {
    const prev = this.reloadLocks.get(code) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const chain = prev.then(() => gate)
    this.reloadLocks.set(code, chain)
    await prev
    try {
      return await task()
    } finally {
      release()
      if (this.reloadLocks.get(code) === chain) this.reloadLocks.delete(code)
    }
  }

  /** 重新读当前目录；内容没变就只读状态、不换代（多版本回退由外部换目录后调这个接口） */
  async reload(code: string, opts: { force?: boolean } = {}): Promise<PluginInfo> {
    return await this.serializeReload(code, async () => {
      try {
        await this.load(code, opts.force === true)
      } catch (e) {
        this.recordFailure(code, e)
        throw e
      }
      return this.mustInfo(code)
    })
  }

  /**
   * 安装/替换一个插件：校验 → 写盘（暂存目录 + 原子 rename）→ 立即换代。
   * 服务只保留当前这一份；历史版本由开发者/发布系统在外部维护，回退=外部换目录后 reload。
   * 注意：安装插件 = 允许在进程内执行任意代码，这是管理员的权力，不是普通调用方的。
   */
  async install(input: InstallInput): Promise<PluginInfo> {
    if (!CODE_RE.test(input.code)) throw new Error(`源码只允许小写字母/数字/下划线：${input.code}`)

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
    // 声明位校验走与扫描同一条（zod）：非法 media_type/version/actions 在这里就失败，
    // 不要等写进盘里再由 scan 记 failed
    pluginManifestSchema.parse(manifest)
    if (manifest.meta.code !== input.code) {
      throw new Error(`manifest.meta.code=${manifest.meta.code} 与提交的源码 ${input.code} 不一致`)
    }
    const entryRel = safeRelPath(String(manifest.entry ?? './index.mjs'))
    if (input.files[entryRel] === undefined) throw new Error(`入口文件 ${entryRel} 不在提交的内容里`)

    return this.writeAndActivate(input.code, input.files)
  }

  /**
   * 安装一个**插件包**（zip）：manifest.json 可以在包根，也可以带 `<code>/` 或旧式 `<code>/<version>/` 前缀
   * （`zip -r` 打包 plugin 目录的产物就是这个形状）。版本从 manifest 读，不再问调用方。
   */
  async installPackage(input: { bytes: Uint8Array }): Promise<PluginInfo> {
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
    return this.install({ code, files })
  }

  /** 写盘（暂存 + 原子 rename）然后换代；失败时恢复老目录（老代继续服务） */
  private async writeAndActivate(code: string, files: Record<string, string>): Promise<PluginInfo> {
    const target = join(this.deps.pluginDir, code)
    const stamp = randomBytes(6).toString('hex')
    const staging = join(this.deps.pluginDir, `.staging-${stamp}`)
    const backup = join(this.deps.pluginDir, `.backup-${stamp}`)
    const hadGeneration = this.loaded.has(code)

    mkdirSync(this.deps.pluginDir, { recursive: true })
    try {
      for (const [rawPath, content] of Object.entries(files)) {
        const abs = join(staging, safeRelPath(rawPath))
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content)
      }
      if (existsSync(target)) renameSync(target, backup)
      renameSync(staging, target)
    } catch (e) {
      rmSync(staging, { recursive: true, force: true })
      if (existsSync(backup) && !existsSync(target)) renameSync(backup, target)
      throw e
    }

    try {
      return await this.reload(code)
    } catch (e) {
      // 没老代就清掉带病目录，避免每次启动报同一条错；有老代则回滚目录并保留老代在飞服务
      rmSync(target, { recursive: true, force: true })
      if (existsSync(backup)) renameSync(backup, target)
      if (!hadGeneration) this.registry.remove(code)
      throw e
    } finally {
      rmSync(backup, { recursive: true, force: true })
    }
  }

  /** 声明落地：幂等；代码没变的 reload 也重跑一次，便于修被误删的设置/配置行 */
  private landDeclarations(manifest: PluginManifest): void {
    this.deps.settings.register(manifest.meta.settings ?? [])
    this.deps.dataSources.upsert(manifest.meta)
    this.deps.onPluginActive?.(manifest.meta)
  }

  private async load(code: string, force = false): Promise<void> {
    const desc = describePlugin(join(this.deps.pluginDir, code))

    if (desc.manifest.meta.code !== code) {
      throw new Error(`manifest.meta.code=${desc.manifest.meta.code} 与目录名 ${code} 不一致`)
    }
    if (!sdkCompatible(desc.manifest.sdk_version, SDK_MAJOR)) {
      throw new Error(`sdk_version=${desc.manifest.sdk_version} 与宿主 ${SDK_VERSION} 不兼容`)
    }

    const fingerprint = pluginFingerprint(desc.dir)
    const current = this.registry.get(code)
    const prior = this.loaded.get(code)
    // failed/disabled 即使指纹相同也要重试（否则坏插件永远修不回来）；active 才算"无变化可跳"
    if (!force && current?.state === 'active' && prior?.fingerprint === fingerprint) {
      this.landDeclarations(desc.manifest)
      this.deps.logger.debug(`插件 ${code}@${desc.version} 代码未变化，跳过换代`)
      return
    }

    // 缓存破坏导入：in-process 模型下这是"换代"的唯一手段
    const url = `${pathToFileURL(desc.entry).href}?v=${encodeURIComponent(desc.version)}-${Date.now()}-${++importSeq}`
    const mod = (await import(url)) as { default?: PluginFactory }
    if (typeof mod.default !== 'function') {
      throw new Error('插件入口必须 export default (sdk) => ({ handlers })（SDK 2）')
    }
    const def = mod.default(createPluginSdk())
    if (!def || typeof def !== 'object' || !def.handlers) {
      throw new Error('插件工厂必须返回 { handlers }')
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
      this.landDeclarations(desc.manifest)
      const worker = new WorkerPluginHost({
        code,
        entry: desc.entry,
        version: desc.version,
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
        version: desc.version,
        isolation: desc.manifest.isolation,
        state: 'active',
        ...(desc.manifest.params ? { params: desc.manifest.params } : {}),
        def: { handlers: {} },
        invoke: (action, params) => worker.call(action, params),
      })
      this.loaded.set(code, { code, version: desc.version, dir: desc.dir, entry: desc.entry, manifest: desc.manifest, fingerprint })
      this.failures.delete(code)
      this.loadCounts.set(code, (this.loadCounts.get(code) ?? 0) + 1)
      this.deps.logger.info(`插件 ${code}@${desc.version} 已生效（worker 隔离，generation=${this.registry.generation}）`)
      return
    }

    // 声明落地：幂等（不覆盖管理员改过的值与 status）
    this.landDeclarations(desc.manifest)
    if (def.onBoot) {
      await def.onBoot({ settings: this.deps.settings, log: (m) => this.deps.logger.info(`onBoot: ${m}`) })
    }

    const prev = this.registry.get(code)
    this.deps.registry.swap({
      code,
      meta: desc.manifest.meta,
      version: desc.version,
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
    this.loaded.set(code, { code, version: desc.version, dir: desc.dir, entry: desc.entry, manifest: desc.manifest, fingerprint })
    this.failures.delete(code)
    this.loadCounts.set(code, (this.loadCounts.get(code) ?? 0) + 1)
    this.deps.logger.info(`插件 ${code}@${desc.version} 已生效（generation=${this.registry.generation}）`)

    // 老代 drain：等它身上的在飞请求走完，再调 dispose
    if (prev && prev.version !== desc.version) {
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

}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
