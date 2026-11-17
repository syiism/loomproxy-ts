// 控制面路由的装配点：四个模块各管一段（插件/鉴权/管理/额度域占位）。
// 这样"加一组端点"只碰对应文件，不在一个 1500 行的文件里找插入点。
import type { FastifyInstance } from 'fastify'
import type { Config } from '@loomproxy/kernel'
import type { DataSourceStore } from '@loomproxy/store'
import type { SourceHost } from '@loomproxy/source-host'
import { registerAdminRoutes } from './routes-admin.ts'
import { registerAuthRoutes } from './routes-auth.ts'
import { registerControlRoutes as registerSourceRoutes } from './routes-control.ts'
import type { ApiStores } from './stores.ts'

export type RouteDeps = {
  config: Config
  host: SourceHost
  dataSources: DataSourceStore
  users?: ApiStores['users']
  roles?: ApiStores['roles']
  plans?: ApiStores['plans']
  sessions?: ApiStores['sessions']
  apiKeys?: ApiStores['apiKeys']
  settings?: ApiStores['settings']
  callLogs?: ApiStores['callLogs']
  quota?: ApiStores['quota']
}

export function registerControlRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const stores: ApiStores = {
    // dataSources 是控制面与插件共用的一张表：一定要进 stores，否则 /admin/data-sources 永远空
    dataSources: deps.dataSources,
    ...(deps.users ? { users: deps.users } : {}),
    ...(deps.roles ? { roles: deps.roles } : {}),
    ...(deps.plans ? { plans: deps.plans } : {}),
    ...(deps.sessions ? { sessions: deps.sessions } : {}),
    ...(deps.apiKeys ? { apiKeys: deps.apiKeys } : {}),
    ...(deps.settings ? { settings: deps.settings } : {}),
    ...(deps.callLogs ? { callLogs: deps.callLogs } : {}),
    ...(deps.quota ? { quota: deps.quota } : {}),
  }
  registerSourceRoutes(app, { config: deps.config, host: deps.host, dataSources: deps.dataSources, stores })
  registerAuthRoutes(app, { config: deps.config, stores })
  registerAdminRoutes(app, { config: deps.config, stores })
}

