// worker 侧运行时：插件在这里跑，ctx.fetch/settings/pool 全部 RPC 回主线程。
// 这个文件由 WorkerHost 以 workerData={entry,code,version} 启动。
import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { ClientCanceled, UpstreamError } from '@loomproxy/contract'
import { createPluginSdk } from '@loomproxy/source-kit'
import type { BridgeFromWorker, BridgeRequest, BridgeError, FetchKind, FetchOpts } from './bridge.ts'
import { serError } from './bridge.ts'
import type { FetchRawResult, HandlerContext, PluginFactory, SourceDefinition } from '@loomproxy/source-kit'

const port = parentPort
if (!port) throw new Error('worker-entry 必须在 worker_threads 里运行')

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void }
const pending = new Map<number, Pending>()
let seq = 0

/** 分发式 Omit：保住联合类型每个成员的字段（直接 Omit 会退化成公共字段） */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

function rpc<T>(msg: DistributiveOmit<BridgeFromWorker, 'id'> & { t: 'fetch' | 'pool' }): Promise<T> {
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    port!.postMessage({ ...msg, id } as BridgeFromWorker)
  })
}

function revive(e: BridgeError): unknown {
  if (e.kind === 'client') return new ClientCanceled()
  if (e.kind === 'upstream') return new UpstreamError(e.statusCode ?? 0, e.message)
  return new Error(e.message)
}

port.on('message', (msg: BridgeRequest) => {
  if (msg.t === 'reply') {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.value)
    else p.reject(revive(msg.error))
    return
  }
  if (msg.t === 'call') {
    void run(msg.id, msg.action, msg.params, msg.settings)
  }
})

let def: SourceDefinition | undefined

async function run(id: number, action: string, params: Record<string, string>, settings: Record<string, string>): Promise<void> {
  try {
    const handler = def?.handlers[action as keyof SourceDefinition['handlers']]
    if (!handler) throw new Error(`插件没有动作 ${action}`)
    const value = await handler(ctx(action, params, settings))
    post({ t: 'result', id, ok: true, value })
  } catch (e) {
    post({ t: 'result', id, ok: false, error: serError(e) })
  }
}

function post(msg: BridgeFromWorker): void {
  port!.postMessage(msg)
}

/** worker 侧的 ctx：取数/设置/池全部过线，实现留在主线程 */
function ctx(action: string, params: Record<string, string>, settings: Record<string, string>): HandlerContext {
  const fetch = {
    json: (url: string, opts?: FetchOpts) => rpc<unknown>({ t: 'fetch', kind: 'json', url, opts: opts ?? {} }),
    text: (url: string, opts?: FetchOpts) => rpc<string>({ t: 'fetch', kind: 'text', url, opts: opts ?? {} }),
    raw: (url: string, opts?: FetchOpts) => rpc<FetchRawResult>({ t: 'fetch', kind: 'raw', url, opts: opts ?? {} }),
  } satisfies Record<FetchKind, unknown>
  return {
    source: workerData.code as string,
    action: action as never,
    params,
    // worker 里没有可取消的本地信号：取消由主线程决定（超时/客户端断开），一次调用要么返回要么被放弃
    signal: new AbortController().signal,
    fetch: fetch as never,
    // 设置：主线程每次调用前现读一份快照带过来（敏感键已按 store 的口径回空串）。
    // 不做过线同步读——HandlerContext.settings 是同步接口，异步化会逼所有源改成 await。
    settings: {
      get: (key: string) => settings[key] ?? '',
      getBool: (key: string, d: boolean) => {
        const v = (settings[key] ?? '').trim().toLowerCase()
        if (['1', 'true', 'yes', 'on'].includes(v)) return true
        if (['0', 'false', 'no', 'off'].includes(v)) return false
        return d
      },
      getInt: (key: string, d: number) => {
        const n = Number(settings[key] ?? '')
        return Number.isFinite(n) ? Math.trunc(n) : d
      },
    },
    pool: (name: string) =>
      ({
        acquire: () => rpc<unknown>({ t: 'pool', op: 'acquire', name }),
        report: (err: unknown) => void rpc<null>({ t: 'pool', op: 'report', name, err: err ? serError(err) : undefined }),
        cooldown: (ident: string, _until?: number, note?: string) =>
          void rpc<null>({ t: 'pool', op: 'cooldown', name, ident, note }),
        success: () => void rpc<null>({ t: 'pool', op: 'success', name }),
      }) as never,
  }
}

async function boot(): Promise<void> {
  const mod = (await import(pathToFileURL(workerData.entry as string).href)) as { default?: PluginFactory }
  if (typeof mod.default !== 'function') throw new Error('插件入口必须 export default (sdk) => ({ handlers })（SDK 2）')
  def = mod.default(createPluginSdk())
  if (!def?.handlers) throw new Error('插件工厂必须返回 { handlers }')
  post({ t: 'ready', code: workerData.code as string, actions: Object.keys(def.handlers) })
}

void boot().catch((e: unknown) => {
  post({ t: 'log', level: 'error', msg: e instanceof Error ? e.message : String(e) })
  throw e
})
