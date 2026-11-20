// 控制面路由的装配点：四个模块各管一段（插件/鉴权/管理/额度域占位）。
// 这样"加一组端点"只碰对应文件，不在一个 1500 行的文件里找插入点。
import type { FastifyInstance } from 'fastify'
import type { Config } from '@loomproxy/kernel'
import type { Ledger } from '@loomproxy/gate'
import type { DataSourceStore } from '@loomproxy/store'
import type { SourceHost } from '@loomproxy/source-host'
import { registerAdminRoutes } from './admin/index.ts'
import { registerAuthRoutes } from './routes-auth.ts'
import { registerControlRoutes as registerSourceRoutes } from './routes-control.ts'
import type { ApiStores } from './stores.ts'

export type RouteDeps = {
  config: Config
  host: SourceHost
  dataSources: DataSourceStore
  /** 内存账本（与 dispatch 同一个实例）：总览的「扣减冷却」读数从这里取 */
  ledger?: Ledger
  users?: ApiStores['users']
  roles?: ApiStores['roles']
  plans?: ApiStores['plans']
  sessions?: ApiStores['sessions']
  apiKeys?: ApiStores['apiKeys']
  settings?: ApiStores['settings']
  callLogs?: ApiStores['callLogs']
  quota?: ApiStores['quota']
  sourceConfigs?: ApiStores['sourceConfigs']
  blockedIPs?: ApiStores['blockedIPs']
  devices?: ApiStores['devices']
  quotaExtra?: ApiStores['quotaExtra']
  sourceGroups?: ApiStores['sourceGroups']
  nameCache?: ApiStores['nameCache']
  schedules?: ApiStores['schedules']
  kv?: ApiStores['kv']
  pools?: ApiStores['pools']
  verification?: ApiStores['verification']
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
    ...(deps.sourceConfigs ? { sourceConfigs: deps.sourceConfigs } : {}),
    ...(deps.blockedIPs ? { blockedIPs: deps.blockedIPs } : {}),
    ...(deps.devices ? { devices: deps.devices } : {}),
    ...(deps.quotaExtra ? { quotaExtra: deps.quotaExtra } : {}),
    ...(deps.sourceGroups ? { sourceGroups: deps.sourceGroups } : {}),
    ...(deps.nameCache ? { nameCache: deps.nameCache } : {}),
    ...(deps.schedules ? { schedules: deps.schedules } : {}),
    ...(deps.kv ? { kv: deps.kv } : {}),
    ...(deps.pools ? { pools: deps.pools } : {}),
    ...(deps.verification ? { verification: deps.verification } : {}),
  }
  registerSourceRoutes(app, { config: deps.config, host: deps.host, dataSources: deps.dataSources, stores })
  registerAuthRoutes(app, { config: deps.config, stores })
  registerAdminRoutes(app, { config: deps.config, stores, dataSources: deps.dataSources, host: deps.host, ...(deps.ledger ? { ledger: deps.ledger } : {}) })
}

