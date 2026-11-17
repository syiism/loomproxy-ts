// 主线程侧的 worker 插件句柄：spawn / 调用 / 桥接取数、设置、池 / 停机。
// 关键取舍（④ §8）：worker 里没有 undici 实例，取数一律 RPC 回主线程——
// 这样代理池/熔断/上游缓存/并发合并仍然只有一份，跨代跨 worker 都成立。
import { Worker } from 'node:worker_threads'
import { ClientCanceled, UpstreamError } from '@loomproxy/contract'
import type { Logger, Upstream } from '@loomproxy/kernel'
import type { BridgeError, BridgeFromWorker, FetchKind, FetchOpts } from './bridge.ts'

export type WorkerHostDeps = {
  logger: Logger
  upstream: Upstream
  settings: { get(key: string): string; list?(): Array<{ key: string; value: string }>; sensitiveKeys?(): string[] }
  pools?: { get(name: string): { acquire(): Promise<unknown>; report(e: unknown): void; cooldown(i: string, u?: number, n?: string): void; success(): void } | undefined }
  /** 单次调用上限（超时即终止 worker：卡死的线程收不回来） */
  callTimeoutMs?: number
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void }

export class WorkerPluginHost {
  private worker: Worker
  private readonly pending = new Map<number, Pending>()
  private seq = 0
  private inflight = 0
  private ready?: Promise<void>
  private readonly actions: string[]

  private readonly deps: WorkerHostDeps & { code: string; entry: string; version: string; actions: string[] }

  constructor(deps: WorkerHostDeps & { code: string; entry: string; version: string; actions: string[] }) {
    this.deps = deps
    this.actions = deps.actions
    this.worker = this.spawn()
  }

  private spawn(): Worker {
    // Worker 只接受路径（或 URL 对象）：入口用 URL 对象，插件入口传路径由 worker 侧转 file URL
    const w = new Worker(new URL('./worker-entry.ts', import.meta.url), {
      workerData: { entry: this.deps.entry, code: this.deps.code, version: this.deps.version },
      // 由调用方（宿主）统一管日志，worker 自己的 console 不落地
      stdout: false,
      stderr: false,
    })
    w.on('message', (msg: BridgeFromWorker) => void this.onMessage(msg))
    w.on('error', (e) => {
      this.deps.logger.error(`worker ${this.deps.code} 崩溃: ${e.message}`)
      this.settleReady(e)
      this.failAll(e)
    })
    w.on('exit', (code) => {
      if (code !== 0) {
        this.deps.logger.warn(`worker ${this.deps.code} 退出（code=${code}）`)
        this.settleReady(new Error(`worker ${this.deps.code} 退出（code=${code}）`))
      }
      this.failAll(new Error(`worker ${this.deps.code} 已退出`))
    })
    // ready 必须有失败出口：worker 起不来（语法/依赖/插件入口错）时不能把调用方永远挂着
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      const timer = setTimeout(() => reject(new Error(`worker ${this.deps.code} 启动超时（5s）`)), 5_000)
      timer.unref?.()
      this.readyTimer = timer
    })
    return w
  }

  private readyResolve?: () => void
  private readyReject?: (e: unknown) => void
  private readyTimer?: NodeJS.Timeout

  private settleReady(e?: unknown): void {
    if (this.readyTimer) clearTimeout(this.readyTimer)
    if (e) this.readyReject?.(e)
    else this.readyResolve?.()
  }

  /** 单次调用：主线程只传 action+params+设置快照，解析/签名都在 worker 里跑 */
  async call(action: string, params: Record<string, string>): Promise<unknown> {
    await this.ready
    const id = ++this.seq
    this.inflight++
    const settings = this.settingsSnapshot()
    return new Promise<unknown>((resolve, reject) => {
      const timeout = this.deps.callTimeoutMs ?? 60_000
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.inflight--
        // 卡死的 worker 收不回来：终止并由宿主下次换代重建
        this.deps.logger.error(`worker ${this.deps.code}/${action} 超时 ${timeout}ms，终止 worker`)
        void this.terminate()
        reject(new UpstreamError(504, `worker 超时（${action}）`))
      }, timeout)
      timer.unref?.()
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          this.inflight--
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          this.inflight--
          reject(e)
        },
      })
      this.worker.postMessage({ t: 'call', id, action, params, settings })
    })
  }

  private settingsSnapshot(): Record<string, string> {
    const out: Record<string, string> = {}
    // 每次调用现读：热配置语义（改了不重启就生效）
    for (const row of this.deps.settings.list?.() ?? []) out[row.key] = row.value
    return out
  }

  private async onMessage(msg: BridgeFromWorker): Promise<void> {
    switch (msg.t) {
      case 'ready':
        this.settleReady()
        return
      case 'log':
        this.deps.logger[msg.level](`[${this.deps.code}] ${msg.msg}`)
        return
      case 'result': {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.value)
        else p.reject(reviveError(msg.error))
        return
      }
      case 'fetch': {
        try {
          const value = await this.doFetch(msg.kind, msg.url, msg.opts)
          this.worker.postMessage({ t: 'reply', id: msg.id, ok: true, value })
        } catch (e) {
          this.worker.postMessage({ t: 'reply', id: msg.id, ok: false, error: serErrorLocal(e) })
        }
        return
      }
      case 'pool': {
        try {
          const value = this.doPool(msg)
          this.worker.postMessage({ t: 'reply', id: msg.id, ok: true, value })
        } catch (e) {
          this.worker.postMessage({ t: 'reply', id: msg.id, ok: false, error: serErrorLocal(e) })
        }
        return
      }
    }
  }

  private async doFetch(kind: FetchKind, url: string, opts: FetchOpts): Promise<unknown> {
    const o = {
      method: opts.method,
      headers: opts.headers ?? {},
      body: opts.body,
      timeoutMs: opts.timeoutMs,
    }
    if (kind === 'json') return this.deps.upstream.fetchJson(url, { ...o, ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}) })
    if (kind === 'text') return this.deps.upstream.fetchText(url, o)
    return this.deps.upstream.fetchRaw(url, {
      ...o,
      ...(opts.cacheKey ? { cacheKey: opts.cacheKey } : {}),
      ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
    })
  }

  private doPool(msg: Extract<BridgeFromWorker, { t: 'pool' }>): unknown {
    const pool = this.deps.pools?.get(msg.name)
    if (!pool) throw new Error(`池 ${msg.name} 未登记`)
    switch (msg.op) {
      case 'acquire':
        return pool.acquire()
      case 'report':
        pool.report(msg.err ? reviveError(msg.err) : undefined)
        return null
      case 'cooldown':
        pool.cooldown(msg.ident ?? '', undefined, msg.note ?? '')
        return null
      case 'success':
        pool.success()
        return null
    }
  }

  /** 等在飞调用走完（换代/卸载时的 grace） */
  async drain(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.inflight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  async terminate(): Promise<void> {
    this.failAll(new ClientCanceled())
    await this.worker.terminate()
  }

  private failAll(e: unknown): void {
    for (const [, p] of this.pending) p.reject(e)
    this.pending.clear()
  }
}

function reviveError(e: BridgeError): unknown {
  if (e.kind === 'client') return new ClientCanceled()
  if (e.kind === 'upstream') return new UpstreamError(e.statusCode ?? 0, e.message)
  return new Error(e.message)
}

function serErrorLocal(e: unknown): BridgeError {
  if (e && typeof e === 'object') {
    const any = e as { name?: string; message?: string; statusCode?: number }
    return {
      name: any.name ?? 'Error',
      message: any.message ?? String(e),
      kind: any.name === 'UpstreamError' ? 'upstream' : any.name === 'ClientCanceled' ? 'client' : 'other',
      ...(typeof any.statusCode === 'number' ? { statusCode: any.statusCode } : {}),
    }
  }
  return { name: 'Error', message: String(e), kind: 'other' }
}
