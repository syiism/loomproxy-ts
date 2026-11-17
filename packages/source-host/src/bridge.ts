// worker 隔离模式的线协议（迁移-TS-4 §2/§8）：主线程 ↔ worker 只传 JSON。
// 设计要点：**取数仍在主线程**——缓存/合并/熔断/代理池必须是一份，
// 所以 worker 里的 ctx.fetch 是 RPC 回来执行；worker 只跑解析/签名/解密这类 CPU 活。
export type FetchKind = 'json' | 'text' | 'raw'

export type BridgeRequest =
  | { t: 'call'; id: number; action: string; params: Record<string, string>; settings: Record<string, string> }
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: BridgeError }

export type BridgeFromWorker =
  | { t: 'ready'; code: string; actions: string[] }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: BridgeError }
  | { t: 'fetch'; id: number; kind: FetchKind; url: string; opts: FetchOpts }
  | { t: 'pool'; id: number; op: 'acquire' | 'report' | 'cooldown' | 'success'; name: string; err?: BridgeError; ident?: string; note?: string }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; msg: string }

export type FetchOpts = {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  cacheKey?: string
  ttlMs?: number
}

/** 过线的错误：类名 + 状态码，主线程按 kind 还原成对应的错误类型 */
export type BridgeError = { name: string; message: string; statusCode?: number; code?: number; kind: 'upstream' | 'client' | 'other' }

export function serError(e: unknown): BridgeError {
  if (e && typeof e === 'object') {
    const any = e as { name?: string; message?: string; statusCode?: number; code?: number }
    const kind: BridgeError['kind'] = any.name === 'UpstreamError' ? 'upstream' : any.name === 'ClientCanceled' ? 'client' : 'other'
    return {
      name: any.name ?? 'Error',
      message: any.message ?? String(e),
      kind,
      ...(typeof any.statusCode === 'number' ? { statusCode: any.statusCode } : {}),
      ...(typeof any.code === 'number' ? { code: any.code } : {}),
    }
  }
  return { name: 'Error', message: String(e), kind: 'other' }
}
