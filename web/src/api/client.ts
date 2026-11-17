// 与 Go 版面板同一份契约（迁移-TS-1 §2/§3）：
// · 成功取 payload.data，`code !== 0` 一律抛错；401 → 清 token 并跳登录。
// 这条**不许改**：改一处面板里所有调用点一起坏。
export const TOKEN_KEY = 'loomproxy_token'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t)
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type Query = Record<string, string | number | boolean | undefined | null>

function buildQuery(query?: Query): string {
  if (!query) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

export type RequestOptions = { method?: string; body?: unknown; query?: Query; headers?: Record<string, string> }

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const token = getToken()
  if (token) headers['authorization'] = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(path + buildQuery(opts.query), {
      method: opts.method ?? 'GET',
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })
  } catch {
    throw new ApiError('网络错误，请检查连接后重试', 0)
  }

  let payload: { code?: number; msg?: string; data?: unknown } | null = null
  try {
    payload = (await res.json()) as typeof payload
  } catch {
    payload = null
  }

  if (res.status === 401) {
    clearToken()
    if (location.pathname !== '/panel/login') location.href = '/panel/login'
    throw new ApiError(payload?.msg ?? '请先登录', 401)
  }
  if (!res.ok || (payload && payload.code !== 0)) {
    throw new ApiError(payload?.msg ?? `请求失败（HTTP ${res.status}）`, res.status)
  }
  return (payload?.data ?? null) as T
}
