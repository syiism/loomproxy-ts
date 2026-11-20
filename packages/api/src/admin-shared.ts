// 管理面共享类型与 helper：被 routes-admin-{account,quota,source,monitor,settings} 复用。
import type { FastifyReply, FastifyRequest } from 'fastify'
import { fail, type RankBoard } from '@loomproxy/contract'
import { createClock, type TtlCache } from '@loomproxy/kernel'
import type { Config } from '@loomproxy/kernel'
import { resolveIdentity } from './auth.ts'
import type { DataSourceStore } from '@loomproxy/store'
import type { SourceHost } from '@loomproxy/source-host'
import type { ApiStores } from './stores.ts'
import type { Ledger } from '@loomproxy/gate'

export type Deps = { config: Config; stores: ApiStores; dataSources?: DataSourceStore; host?: SourceHost; ledger?: Ledger }

export type AdminContext = Deps & {
  unavailable: (reply: FastifyReply, msg: string) => void
  guard: (req: FastifyRequest, reply: FastifyReply) => Promise<boolean>
  boardsCache: TtlCache<RankBoard[]>
}

// 接口监控页的"统计起点"：进程启动时刻。Go 版用内存计数器的启动时间，TS 用 DB 累计读数，
// 但起点语义一致（本次服务进程开始统计的时刻），重启会刷新——面板文案的"重启清零"口径对这部分成立。
export const MONITOR_STARTED_AT = new Date().toISOString()

/** 明细里的 #user_id 兜底 → 查 users 补真实名（API Key 调用的历史行） */
export function displayName(username: string, names: Map<number, string>): string {
  const m = /^#(\d+)$/.exec(username)
  return m ? (names.get(Number(m[1])) ?? username) : (username || '')
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply, deps: Deps) {
  const id = await resolveIdentity(req, deps.config, {
    ...(deps.stores.sessions ? { sessions: deps.stores.sessions } : {}),
    ...(deps.stores.apiKeys ? { apiKeys: deps.stores.apiKeys } : {}),
    ...(deps.stores.users ? { users: deps.stores.users } : {}),
  })
  if (!id.roles.includes('admin')) {
    // 浏览器直接打开一个"要管理员的文档"（如 report.html）时，302 到登录比甩 JSON 有用；
    // 面板的 fetch 不会带 text/html，所以接口语义不变。
    if (String(req.headers.accept ?? '').includes('text/html')) {
      const next = encodeURIComponent(req.url)
      reply.code(302).header('location', `/login?next=${next}`)
      reply.send()
      return undefined
    }
    reply.code(403).send(fail(deps.config.errorCode, '需要管理员权限'))
    return undefined
  }
  return id
}

/** 平台时区日界的窗口起点：当日零点往前推 days-1 天（与 Go 的 WindowStart 同口径） */
export function windowSince(tzOffsetHours: number, days: number): string {
  const clock = createClock(tzOffsetHours)
  return new Date(clock.startOfDay() - (Math.max(1, days) - 1) * 86_400_000).toISOString()
}

/** 公开榜单放行名单存在设置项 rank_public_sources 里（逗号分隔），不是源行上的列 */
export function rankPublicSet(settings?: { get(key: string): string }): Set<string> {
  const raw = (settings?.get('rank_public_sources') ?? '').trim()
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
}

export function setRankPublic(settings: { get(key: string): string; set(key: string, v: string): void } | undefined, source: string, on: boolean): boolean {
  if (!settings) throw new Error('设置存储未接')
  const set = rankPublicSet(settings)
  if (on) set.add(source)
  else set.delete(source)
  settings.set('rank_public_sources', [...set].sort().join(','))
  return on
}

/** 下次清零时刻（平台时区下一个 0 点），形状与 Go 的 nextResetTime 一致：2026/11/18 00:00:00 */
export function nextResetLabel(tzOffsetHours: number): string {
  const offsetMs = tzOffsetHours * 3600_000
  const local = Date.now() + offsetMs
  const next = (Math.floor(local / 86_400_000) + 1) * 86_400_000 - offsetMs
  // next 是 UTC 时刻；要显示的是**平台时区**的钟点，所以把位移加回去再读 UTC 分量
  const d = new Date(next + offsetMs)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`
}
