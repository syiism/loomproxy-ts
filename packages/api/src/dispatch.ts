// 数据面派发：/{source}/{action} → 注册表现取 → 链 → handler。
// 契约不变（迁移-TS-1 §5）；实现从"启动期逐条注册路由"改成"一个 catch-all 查表"，
// 于是新插件加载完立刻可用（迁移-TS-4 §5）。
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ClientCanceled, isUpstreamError, newSubject } from '@loomproxy/contract'
import type { Config, Logger, Upstream } from '@loomproxy/kernel'
import type { Pool } from '@loomproxy/pool'
import { Ledger, RateLimiter, accessMessage, contentKeyOf, sourceAccessVerdict } from '@loomproxy/gate'
import { createFetchFacade, observeCall, stampSearchSource } from '@loomproxy/source-kit'
import type {
  ApiKeyStore,
  CallLogStore,
  DataSourceStore,
  DbQuota,
  DbUsers,
  SessionStore,
  SettingsStore,
} from '@loomproxy/store'
import type { SourceHost } from '@loomproxy/source-host'
import { resolveIdentity } from './auth.ts'
import { trackCall } from './calls.ts'
import { buildParams, declaredParams, missingRequired } from './params.ts'
import { scrubInBandMsg } from './scrub.ts'
import type { ActionName } from '@loomproxy/contract'

export type DispatchDeps = {
  config: Config
  /**
   * 匿名（免费套餐）允许哪些源：真实实现读套餐配置；
   * 初始切片按全放行，与现网 `AUTH_ENABLED=false` 的默认行为一致。
   */
  freePlanAllows?: (source: string) => boolean
  logger: Logger
  upstream: Upstream
  host: SourceHost
  dataSources: DataSourceStore
  settings: SettingsStore
  ledger: Ledger
  limiter: RateLimiter
  /** 面板回退：路径不是任何数据源、且调用方是浏览器时，把 index.html 交给它（history 路由深层链接） */
  spaFallback?: (req: { url: string }, reply: import('fastify').FastifyReply) => Promise<void>
  /** 明细写入口：与平台其余部分同一条（出口 hook 记，不在 handler 里记） */
  callLogs?: CallLogStore
  /** 会话与账号密钥：有它们才做"撤销即刻失效/密钥认出归属" */
  sessions?: SessionStore
  apiKeys?: ApiKeyStore
  users?: DbUsers
  quota?: DbQuota
  nameCache?: { remember(kind: 'book' | 'chapter', source: string, ident: string, name: string): void }
  quotaExtra?: { rateSpecFor(planId: number | null, source: string, action: string): { intervalMs?: number; count?: number; windowMs?: number } }
  blockedIPs?: { isBlocked(ip: string): boolean }
  /** 池运行时（packages/pool）：源通过 ctx.pool(name) 取号 */
  pools?: { get(name: string): Pool | undefined }
}

function sanitizeMessage(msg: string): string {
  return msg.includes('://') ? '上游请求失败，请稍后重试' : msg
}

/** 同内容去重窗口（内存态；跨重启会重复扣一次，与 Go 版同取舍） */
const dedupeWindow = new Map<string, number>()

export function createDispatcher(deps: DispatchDeps) {
  const fetch = createFetchFacade(deps.upstream)

  return async function dispatch(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { source, action } = req.params as { source: string; action: string }
    const resolved = deps.host.registryRef.resolve(source, action as ActionName)
    if (!resolved) {
      // 面板用 history 路由，深层链接（如 /admin/plugins）也是两段路径，与 /{source}/{action} 同形。
      // 靠**归属**区分：不是已登记的源，且调用方是浏览器（Accept 含 text/html）→ 回面板；
      // 其它（API 客户端 / curl）照旧 404 JSON —— 下游契约不变。
      const wantsHtml = String(req.headers['accept'] ?? '').includes('text/html')
      if (wantsHtml && deps.spaFallback && !deps.host.registryRef.get(source)) {
        await deps.spaFallback(req, reply)
        return
      }
      reply.code(404).send({ code: 404, msg: 'not found' })
      return
    }
    const { entry, handler } = resolved
    // 黑名单在数据面入口就拦（登录/注册那边同一张表，见 routes-auth）
    if (deps.blockedIPs?.isBlocked(req.ip)) {
      reply.code(403).send({ code: deps.config.errorCode, msg: '你的 IP 已被拉黑，请联系管理员' })
      return
    }
    const identity = await resolveIdentity(req, deps.config, {
      ...(deps.sessions ? { sessions: deps.sessions } : {}),
      ...(deps.apiKeys ? { apiKeys: deps.apiKeys } : {}),
      ...(deps.users ? { users: deps.users } : {}),
    })
    // 明细的请求级上下文：出口 hook 用它记账（含 400/403/429/5xx，与 Go 的 monitor 同口径）
    const subject = newSubject()
    trackCall(req, {
      source,
      action,
      params: {},
      username: identity.username ?? (identity.userId !== undefined ? `#${identity.userId}` : 'anonymous'),
      ip: req.ip,
      startedAt: Date.now(),
      pluginVersion: entry.version,
      subject,
    })

    // 在飞计数：换代要等这一代身上的请求走完（迁移-TS-4 §4）
    deps.host.begin(source)
    const ac = new AbortController()
    req.raw.once('close', () => ac.abort())
    try {
      const declared = declaredParams(entry.params, action)
      const params = buildParams(declared, req.query as Record<string, unknown>, {
        ...(identity.userId !== undefined ? { uid: identity.userId } : {}),
      })

      trackCall(req, {
        source,
        action,
        params,
        username: identity.username ?? (identity.userId !== undefined ? `#${identity.userId}` : 'anonymous'),
        ip: req.ip,
        startedAt: Date.now(),
        pluginVersion: entry.version,
        subject,
      })

      // 350：必填参数（缺 → 400，不让源返回带内错误正文）
      const missing = missingRequired(entry.meta, action, params)
      if (missing.length > 0) {
        reply.code(400).send({ code: deps.config.errorCode, msg: `缺少必填参数：${missing.join(',')}` })
        return
      }

      // 维护模式：数据面一律 503，管理员除外（设置项 maintenance_mode，热读）
    if (deps.settings.getBool('maintenance_mode', false) && !identity.roles.includes('admin')) {
      reply.code(503).send({ code: deps.config.errorCode, msg: '系统维护中，请稍后再试' })
      return
    }

    // 400：访问判定（源存在 → 启用 → 匿名免费档 → 管理员 → 套餐授权）
      const ds = deps.dataSources.get(source)
      const reason = sourceAccessVerdict({
        meta: entry.meta,
        enabled: ds?.status === 1,
        caller:
          identity.userId === undefined
            ? { kind: 'anonymous', freePlanAllows: (deps.freePlanAllows ?? (() => true))(source) }
            : { kind: 'user', isAdmin: identity.roles.includes('admin'), hasPlan: true, granted: true },
      })
      if (reason !== '') {
        const code = reason === 'not_found' ? 404 : reason === 'need_login' ? 401 : 403
        reply.code(code).send({ code: deps.config.errorCode, msg: accessMessage(reason) })
        return
      }

      // 500：额度预检（每次现取成本与生效额度：面板改完立刻生效）
      const quota = deps.quota
      const user = identity.userId !== undefined ? deps.users?.byId(identity.userId) : undefined
      const costRow = quota?.costOf(source, action)
      const cost = costRow && costRow.status === 1 ? costRow.cost : 0
      const since = user && quota ? quota.startOfWindow(user.id, deps.config.tzOffsetHours) : ''
      if (user && quota && cost > 0) {
        const limit = quota.effectiveLimit(user.id, user.plan_id, source)
        const used = quota.usedSince(user.id, source, since)
        if (limit >= 0 && used + cost > limit) {
          reply.code(429).send({
            code: deps.config.errorCode,
            msg: `今日 ${source} 额度已用完（${used}/${limit}），请明日再来或联系管理员调整套餐`,
          })
          return
        }
      }

      // 600：限流（IP 与用户双维度，两者都放行才放行）
      // 参数每次现取：套餐覆盖 → 全局成本行 → 无（不限）。改完立刻生效
      const spec = deps.quotaExtra?.rateSpecFor(user?.plan_id ?? null, source, action) ?? {}
      const userKey = identity.userId !== undefined ? `u:${identity.userId}` : 'u:anon'
      if (!deps.limiter.allow(`ip:${req.ip}`, { count: 30, windowMs: 60_000 })) {
        reply.code(429).send({ code: deps.config.errorCode, msg: '接口请求过于频繁，请稍后重试' })
        return
      }
      const userSpec =
        spec.count !== undefined && spec.windowMs !== undefined
          ? { count: spec.count, windowMs: spec.windowMs }
          : spec.intervalMs !== undefined
            ? { intervalMs: spec.intervalMs }
            : { intervalMs: 1000 }
      if (!deps.limiter.allow(`${userKey}:${source}:${action}`, userSpec)) {
        reply.code(429).send({ code: deps.config.errorCode, msg: '接口请求过于频繁，请稍后重试' })
        return
      }

      const started = Date.now()
      let result: unknown
      try {
        const ctx = {
          source,
          action: action as ActionName,
          params,
          signal: ac.signal,
          fetch,
          settings: deps.host.settingsReader(),
          ...(deps.pools
            ? {
                pool: (name: string) => {
                  const pool = deps.pools?.get(name)
                  if (!pool) throw new Error(`池 ${name} 未登记`)
                  return pool
                },
              }
            : {}),
        }
        result = entry.invoke ? await entry.invoke(action as ActionName, params) : await handler(ctx)

      } catch (e) {
        // 客户端取消：出口静默（对应 Go 的 context.Canceled 分支），不写响应体
        if (e instanceof ClientCanceled || ac.signal.aborted) {
          reply.raw.destroy()
          return
        }
        if (isUpstreamError(e)) {
          const status = e.statusCode === 0 ? 502 : e.statusCode === 504 ? 504 : 502
          reply.code(status).send({ code: deps.config.errorCode, msg: sanitizeMessage(e.message) })
          return
        }
        deps.logger.error(`${source}/${action} 失败: ${e instanceof Error ? e.message : String(e)}`)
        reply.code(500).send({ code: deps.config.errorCode, msg: '数据源处理失败' })
        return
      }

      // 出口三处改写，顺序固定：观测 → 打标 → 带内脱敏
      // 观测要把源声明一起带上：单媒介源（如 fq_novel 声明 media_type=novel）的搜索响应里
      // 没有 bookTypeCode，不把声明当兜底就永远落成"未判定"（面板筛选/覆盖率全跟着错）。
      observeCall(source, params, result, subject, {
        ...(entry.meta.media_type ? { media: entry.meta.media_type } : {}),
        ...(entry.meta.search_tabs ? { searchTabs: entry.meta.search_tabs } : {}),
      })
      // 名称进缓存：bookId/itemId 是标识，书名/章节名靠这里攒起来（回填与明细展示都读它）
      if (subject.book_name) deps.nameCache?.remember('book', source, params['bookId'] ?? '', subject.book_name)
      if (subject.chapter_title) deps.nameCache?.remember('chapter', source, params['itemId'] ?? '', subject.chapter_title)
      if (action === 'search') result = stampSearchSource(result, source)
      result = scrubInBandMsg(result)

      // 计费入账：成功且非带内失败才扣（去重窗口挡住"客户端超时重试"重复扣费）
      if (user && quota && cost > 0 && !subject.in_band_error) {
        const k = `${user.id}:${source}:${action}:${contentKeyOf(action, params)}`
        const last = dedupeWindow.get(k)
        const now = Date.now()
        if (!last || now - last >= deps.config.billingDedupeSec * 1000) {
          dedupeWindow.set(k, now)
          quota.appendUsage({ user_id: user.id, username: user.username, group_code: source, action, cost })
        }
      } else if (identity.userId !== undefined) {
        deps.ledger.charge(identity.userId, source, action, contentKeyOf(action, params), 1, deps.config.billingDedupeSec * 1000)
      }
      deps.logger.debug(`${source}/${action} ${Date.now() - started}ms inband=${subject.in_band_error}`)

      // 数据面是裸对象，不加 code/msg
      reply.code(200).send(result)
    } finally {
      deps.host.end(source)
    }
  }
}
