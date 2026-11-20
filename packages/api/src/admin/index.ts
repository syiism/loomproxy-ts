// 管理面：总览读数、用户、角色、套餐、设置、数据源、监控、号池(空)、公开榜。
// 额度/卡密/分组/定时/IP/设备/接口消耗属"未接域"：显式 501 并说清是哪个域，
// 面板会把 msg 原样 toast 出来——不假造成功。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { fail } from '@loomproxy/contract'
import { TtlCache } from '@loomproxy/kernel'
import type { RankBoard } from '@loomproxy/contract'
import { notWired } from '../stores.ts'
import { type Deps, type AdminContext, requireAdmin } from './shared.ts'
import { registerAccountRoutes } from './account.ts'
import { registerQuotaRoutes } from './quota.ts'
import { registerSourceRoutes } from './source.ts'
import { registerMonitorRoutes } from './monitor.ts'
import { registerSettingsRoutes } from './settings.ts'

export function registerAdminRoutes(app: FastifyInstance, deps: Deps): void {
  const { config } = deps
  const unavailable = (reply: FastifyReply, msg: string) => {
    const n = notWired(msg)
    reply.code(n.status).send(fail(config.errorCode, n.msg))
  }
  const guard = async (req: FastifyRequest, reply: FastifyReply) => (await requireAdmin(req, reply, deps)) !== undefined
  // 公开榜的聚合结果缓存（RankCacheSec<=0 每次真算）。键含"谁在看"那一段：
  // 管理员（不限源）与公开榜（按白名单）共用键段就等于把未授权源的热度漏给普通用户。
  const boardsCache = new TtlCache<RankBoard[]>({ maxEntries: 64, ttlMs: Math.max(0, config.rankCacheSec) * 1000 })
  const ctx: AdminContext = { ...deps, unavailable, guard, boardsCache }
  registerAccountRoutes(app, ctx)
  registerQuotaRoutes(app, ctx)
  registerSourceRoutes(app, ctx)
  registerMonitorRoutes(app, ctx)
  registerSettingsRoutes(app, ctx)

  // ---- 明确未接的域（面板有页、后端没有） ----
  const stubs: Array<[string, string, string]> = [
  ]
  for (const [method, path, what] of stubs) {
    const m = method.toLowerCase() as 'get' | 'post' | 'put' | 'delete'
    app[m](path, async (_req, reply) => unavailable(reply, what))
  }
}
