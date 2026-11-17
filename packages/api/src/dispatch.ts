// 数据面派发：/{source}/{action} → 注册表现取 → 链 → handler。
// 契约不变（迁移-TS-1 §5）；实现从"启动期逐条注册路由"改成"一个 catch-all 查表"，
// 于是新插件加载完立刻可用（迁移-TS-4 §5）。
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ClientCanceled, isUpstreamError, newSubject } from '@loomproxy/contract'
import type { Config, Logger, Upstream } from '@loomproxy/kernel'
import { Ledger, RateLimiter, accessMessage, contentKeyOf, sourceAccessVerdict } from '@loomproxy/gate'
import { createFetchFacade, observeCall, stampSearchSource } from '@loomproxy/source-kit'
import type { CallLogStore, DataSourceStore, SettingsStore } from '@loomproxy/store'
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
  /** 明细写入口：与平台其余部分同一条（出口 hook 记，不在 handler 里记） */
  callLogs?: CallLogStore
}

function sanitizeMessage(msg: string): string {
  return msg.includes('://') ? '上游请求失败，请稍后重试' : msg
}

export function createDispatcher(deps: DispatchDeps) {
  const fetch = createFetchFacade(deps.upstream)

  return async function dispatch(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { source, action } = req.params as { source: string; action: string }
    const resolved = deps.host.registryRef.resolve(source, action as ActionName)
    if (!resolved) {
      reply.code(404).send({ code: 404, msg: 'not found' })
      return
    }
    const { entry, handler } = resolved
    const identity = resolveIdentity(req, deps.config)
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

      // 600：限流（IP 与用户双维度，两者都放行才放行）
      const userKey = identity.userId !== undefined ? `u:${identity.userId}` : 'u:anon'
      if (!deps.limiter.allow(`ip:${req.ip}`, { count: 30, windowMs: 60_000 })) {
        reply.code(429).send({ code: deps.config.errorCode, msg: '接口请求过于频繁，请稍后重试' })
        return
      }
      if (!deps.limiter.allow(`${userKey}:${source}:${action}`, { intervalMs: 1000 })) {
        reply.code(429).send({ code: deps.config.errorCode, msg: '接口请求过于频繁，请稍后重试' })
        return
      }

      const started = Date.now()
      let result: unknown
      try {
        result = await handler({
          source,
          action: action as ActionName,
          params,
          signal: ac.signal,
          fetch,
          settings: deps.host.settingsReader(),
        })
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
      observeCall(source, params, result, subject)
      if (action === 'search') result = stampSearchSource(result, source)
      result = scrubInBandMsg(result)

      // 500：计费（成功后扣减，同内容窗口内去重）
      if (identity.userId !== undefined) {
        deps.ledger.charge(
          identity.userId,
          source,
          action,
          contentKeyOf(action, params),
          1,
          deps.config.billingDedupeSec * 1000,
        )
      }
      deps.logger.debug(`${source}/${action} ${Date.now() - started}ms inband=${subject.in_band_error}`)

      // 数据面是裸对象，不加 code/msg
      reply.code(200).send(result)
    } finally {
      deps.host.end(source)
    }
  }
}
