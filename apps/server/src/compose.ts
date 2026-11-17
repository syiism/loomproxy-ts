// 装配的纯函数版：main.ts 与 e2e 用例共用同一条装配路径。
// 顺序：读 env → 开库/迁移 → 播种（角色/默认套餐/管理员/设置）→ 插件扫描 → 路由 → 返回。
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { TtlCache, Upstream, createLogger, loadConfig, type Config, type Logger } from '@loomproxy/kernel'
import {
  DbApiKeys,
  DbCallLogs,
  DbDataSources,
  DbPlans,
  DbRoles,
  DbSessions,
  DbBlockedIPs,
  DbDevices,
  DbNameCache,
  DbSchedules,
  DbQuotaExtra,
  DbSourceGroups,
  DbQuota,
  DbSourceConfigs,
  DbSettings,
  DbUsers,
  SqliteDb,
  hashPassword,
} from '@loomproxy/store'
import { SourceRegistry } from '@loomproxy/source-kit'
import { SourceHost } from '@loomproxy/source-host'
import { buildServer } from '@loomproxy/api'
import type { FastifyInstance } from 'fastify'

export type ComposeOptions = {
  env?: Record<string, string | undefined>
  logger?: Logger
}

export type Composed = {
  config: Config
  app: FastifyInstance
  db: SqliteDb
  host: SourceHost
  registry: SourceRegistry
  settings: DbSettings
  dataSources: DbDataSources
  users: DbUsers
  roles: DbRoles
  plans: DbPlans
  sessions: DbSessions
  apiKeys: DbApiKeys
  callLogs: DbCallLogs
  quota: DbQuota
  sourceConfigs: DbSourceConfigs
  blockedIPs: DbBlockedIPs
  devices: DbDevices
  nameCache: DbNameCache
  schedules: DbSchedules
  quotaExtra: DbQuotaExtra
  sourceGroups: DbSourceGroups
}

/** 内置角色：面板与 access 判定都按 code 读（admin/vip/user） */
const BUILTIN_ROLES = [
  { code: 'admin', name: '管理员', description: '全部权限' },
  { code: 'vip', name: 'VIP', description: '高额度用户' },
  { code: 'user', name: '普通用户', description: '基础用户' },
]

/** 内置设置项：与 Go 版 seed 同名的三档（公告/维护/公开榜放行） */
const BUILTIN_SETTINGS = [
  { key: 'announcement', type: 'string' as const, default: '', description: '站内公告（空 = 无公告）' },
  { key: 'maintenance_mode', type: 'bool' as const, default: 'false', description: '维护模式：数据面一律 503，管理员除外' },
  { key: 'rank_public_sources', type: 'string' as const, default: '', description: '公开榜放行的数据源（逗号分隔，空 = 全不放行）' },
]

export async function compose(opts: ComposeOptions = {}): Promise<Composed> {
  // env 只读一次：配置加载与账号初始化必须看同一份（否则注入给测试的 ADMIN_PASSWORD 读不到自己）
  const env = opts.env ?? process.env
  const config = loadConfig(env)
  const logger = opts.logger ?? createLogger(config.serverLogLevel, 'loomproxy')
  for (const w of config.warnings) logger.warn(w)

  const dbPath = env['DB_PATH'] ?? join(config.dataDir, 'loomproxy.db')
  const db = new SqliteDb(dbPath)
  db.migrate()

  const settings = new DbSettings(db)
  settings.register(BUILTIN_SETTINGS)
  const dataSources = new DbDataSources(db)
  const users = new DbUsers(db)
  const roles = new DbRoles(db)
  const plans = new DbPlans(db)
  const sessions = new DbSessions(db)
  const apiKeys = new DbApiKeys(db)
  const callLogs = new DbCallLogs(db)
  const quota = new DbQuota(db)
  const sourceConfigs = new DbSourceConfigs(db)
  const blockedIPs = new DbBlockedIPs(db)
  const devices = new DbDevices(db)
  const nameCache = new DbNameCache(db)
  const schedules = new DbSchedules(db)
  const quotaExtra = new DbQuotaExtra(db, quota)
  const sourceGroups = new DbSourceGroups(db, quota)

  // ---- 播种：角色 → 默认套餐 → 管理员 ----
  for (const r of BUILTIN_ROLES) {
    if (!roles.list().some((x) => x.code === r.code)) roles.create(r)
  }
  const defaultPlan = plans.list()[0] ?? plans.create({ name: '基础版', code: 'basic', description: '默认套餐' })
  const adminName = (env['ADMIN_USERNAME'] ?? 'admin').trim().toLowerCase()
  const generated = !env['ADMIN_PASSWORD'] ? randomBytes(9).toString('base64url') : ''
  const adminPass = env['ADMIN_PASSWORD'] ?? generated
  if (!users.byUsernameOrEmail(adminName)) {
    users.create({
      username: adminName,
      password: adminPass,
      nickname: adminName,
      planId: defaultPlan.id,
      roles: ['admin'],
    })
    if (generated) logger.warn(`已创建管理员 ${adminName}，本次生成的登录密码是：${generated}`)
    else logger.info(`已创建管理员 ${adminName}`)
  } else if (generated) {
    logger.warn(`管理员 ${adminName} 已存在；ADMIN_PASSWORD 未设置时不会重置已有密码`)
  }
  // hashPassword 在播种之外也要可用（改密走 users.setPassword）
  void hashPassword

  const upstreamCache = new TtlCache<unknown>({
    maxEntries: config.upstreamCacheMaxSize,
    ttlMs: config.upstreamCacheTtlSec * 1000,
  })
  const upstream = new Upstream({ config, logger: logger.child('upstream'), cache: upstreamCache })
  const registry = new SourceRegistry()
  const host = new SourceHost({
    pluginDir: config.pluginDir,
    logger: logger.child('host'),
    registry,
    settings,
    dataSources,
    upstream,
  })
  const infos = await host.scanSync()
  // 每个已加载动作登记一条成本（缺省 1 点；面板「接口」页可改）。缺成本行 = 不计费，流水永远空
  for (const info of infos) {
    if (info.state !== 'active') continue
    const entry = registry.get(info.code)
    if (!entry) continue
    for (const action of entry.meta.actions) {
      if (!quota.costOf(info.code, action)) quota.upsertCost({ group_code: info.code, interface: action, cost: 1 })
    }
  }
  logger.info(`插件扫描完成：${infos.length} 个（active=${infos.filter((i) => i.state === 'active').length}）`)

  const app = buildServer({
    config,
    logger: logger.child('api'),
    upstream,
    host,
    dataSources,
    settings,
    users,
    roles,
    plans,
    sessions,
    apiKeys,
    callLogs,
    quota,
    sourceConfigs,
    blockedIPs,
    devices,
    nameCache,
    schedules,
    quotaExtra,
    sourceGroups,
  })
  return { config, app, db, host, registry, settings, dataSources, users, roles, plans, sessions, apiKeys, callLogs, quota, sourceConfigs, blockedIPs, devices, nameCache, schedules, quotaExtra, sourceGroups }
}
