// HTTP 装配：静态路由优先，剩下 /:source/:action 走查表派发（迁移-TS-4 §5）。
// 明细记账挂在 onResponse（对应 Go 的 monitor 中间件在 c.Next() 之后那一半），
// 这样 400/403/429/5xx 都进明细——把手写在 handler 里就会漏掉中间件拒绝的那些。
import Fastify, { type FastifyInstance } from 'fastify'
import type { Config, Logger, Upstream } from '@loomproxy/kernel'
import type { CallLogStore, DataSourceStore, SettingsStore, UserStore } from '@loomproxy/store'
import type { SourceHost } from '@loomproxy/source-host'
import { Ledger, RateLimiter } from '@loomproxy/gate'
import { callMetaOf, toCallLogRow } from './calls.ts'
import { createDispatcher } from './dispatch.ts'
import { registerWebRoutes } from './web.ts'
import { registerControlRoutes } from './routes.ts'

export type ApiDeps = {
  config: Config
  logger: Logger
  upstream: Upstream
  host: SourceHost
  dataSources: DataSourceStore
  settings: SettingsStore
  users?: UserStore
  callLogs?: CallLogStore
  ledger?: Ledger
  limiter?: RateLimiter
}

export function buildServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    routerOptions: {
      // 面板与下游都用 query 传参：值**永远是字符串**，不许被解释成 bool/数字
      // （Go 版 param-assert-check 钉的同一条：数字断言 = 静默死代码）
      querystringParser: (str: string) =>
        Object.fromEntries(new URLSearchParams(str).entries()) as Record<string, string>,
    },
  })

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id)
  })
  app.addHook('onResponse', async (req, reply) => {
    const meta = callMetaOf(req)
    if (!meta || !deps.callLogs) return
    deps.callLogs.append(toCallLogRow(meta, reply.statusCode, new Date().toISOString()))
  })

  registerControlRoutes(app, {
    config: deps.config,
    host: deps.host,
    dataSources: deps.dataSources,
    users: deps.users,
    callLogs: deps.callLogs,
  })
  registerWebRoutes(app, { webDir: deps.config.webDist, logger: deps.logger })

  const dispatch = createDispatcher({
    config: deps.config,
    logger: deps.logger,
    upstream: deps.upstream,
    host: deps.host,
    dataSources: deps.dataSources,
    settings: deps.settings,
    ledger: deps.ledger ?? new Ledger(),
    limiter: deps.limiter ?? new RateLimiter(),
    ...(deps.callLogs ? { callLogs: deps.callLogs } : {}),
  })

  // catch-all：新插件加载完立刻可用，不需要 removeRoute/addRoute
  app.get('/:source/:action', dispatch)

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ code: 404, msg: 'not found' })
  })

  return app
}
