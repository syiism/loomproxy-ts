// 装配的纯函数版：main.ts 与 e2e 用例共用同一条装配路径。
// 顺序：读 env → 开库/迁移 → 播种（角色/默认套餐/管理员/设置）→ 插件扫描 → 路由 → 返回。
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { TtlCache, Upstream, createLogger, loadConfig, type Config, type Logger } from '@loomproxy/kernel'
import {
  DbKv,
  seedBuiltinSettings,
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
  DbPoolDevices,
  DbQuota,
  DbSourceConfigs,
  DbSettings,
  DbUsers,
  SqliteDb,
  hashPassword,
} from '@loomproxy/store'
import { createPoolRuntime } from '@loomproxy/pool'
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
  kv: DbKv
  pools: ReturnType<typeof createPoolRuntime>
  quotaExtra: DbQuotaExtra
  sourceGroups: DbSourceGroups
}

/** 内置角色：面板与 access 判定都按 code 读（admin/vip/user） */
const BUILTIN_ROLES = [
  { code: 'admin', name: '管理员', description: '全部权限' },
  { code: 'vip', name: 'VIP', description: '高额度用户' },
  { code: 'user', name: '普通用户', description: '基础用户' },
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
  // 内置设置：键/初值/类型/说明与 Go 的 db/seed.go 逐条对齐（29 条），幂等且不覆盖管理员改过的值
  seedBuiltinSettings(settings, (m) => logger.info(m))
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
  const defaultPlan = plans.list()[0] ?? // 与内置设置 default_quota_plan=free 对齐（否则"新用户默认套餐"这个键指向一个不存在的 code）
    plans.create({ name: '免费版', code: 'free', description: '默认套餐' })
  // ---- 管理员口令：来源标记决定了"重启后 env 里的密码还算不算数" ----
  // 现场（2026-11-17）：首启没写 ADMIN_PASSWORD → 随机生成并打印；之后把密码写进 .env 再重启，
  // 因为"已存在就不动"，env 里的密码永远不生效，登录一直失败。分不清来源就会这么猜。
  const kv = new DbKv(db)
  const adminName = (env['ADMIN_USERNAME'] ?? 'admin').trim().toLowerCase()
  const envPass = env['ADMIN_PASSWORD'] ?? ''
  const forceSync = ['1', 'true', 'yes', 'on'].includes(String(env['ADMIN_PASSWORD_SYNC'] ?? '').toLowerCase())
  const existing = users.byUsernameOrEmail(adminName)
  if (!existing) {
    const generated = envPass ? '' : randomBytes(9).toString('base64url')
    users.create({
      username: adminName,
      password: envPass || generated,
      nickname: adminName,
      planId: defaultPlan.id,
      roles: ['admin'],
    })
    kv.set(`admin_password_source:${adminName}`, envPass ? 'env' : 'generated')
    if (generated) logger.warn(`已创建管理员 ${adminName}，本次生成的登录密码是：${generated}（写进 .env 的 ADMIN_PASSWORD 后重启即生效）`)
    else logger.info(`已创建管理员 ${adminName}（口令来自 ADMIN_PASSWORD）`)
  } else {
    const source = kv.get(`admin_password_source:${adminName}`) || 'unknown'
    const envMatches = envPass !== '' && users.verify(adminName, envPass) !== undefined
    if (forceSync && envPass && !envMatches) {
      users.setPassword(existing.id, envPass)
      kv.set(`admin_password_source:${adminName}`, 'env')
      logger.warn(`ADMIN_PASSWORD_SYNC=true：管理员 ${adminName} 的口令已按 env 重置（覆盖了此前的值）`)
    } else if (source === 'generated' && envPass) {
      // 上次是随机生成的口令（可能只出现在一次启动日志里）→ env 是更好的来源，直接接管
      users.setPassword(existing.id, envPass)
      kv.set(`admin_password_source:${adminName}`, 'env')
      logger.warn(`管理员 ${adminName} 的口令已按 env 的 ADMIN_PASSWORD 重置（此前是启动时随机生成的）`)
    } else if (source === 'panel') {
      logger.info(`管理员 ${adminName} 的口令以面板为准（面板上改过）；如需用 env 覆盖：ADMIN_PASSWORD_SYNC=true`)
    } else if (envPass && !envMatches) {
      logger.warn(
        `ADMIN_PASSWORD 与库中口令不一致（管理员 ${adminName}）。可能是面板上改过；要强制以 env 为准：ADMIN_PASSWORD_SYNC=true`,
      )
    } else if (!envPass) {
      logger.warn(`未设置 ADMIN_PASSWORD：管理员 ${adminName} 沿用库中口令（忘了就设 ADMIN_PASSWORD_SYNC=true 再重启）`)
    }
  }
  logger.info(`数据库 ${dbPath}　管理员 ${adminName}`)
  // hashPassword 在播种之外也要可用（改密走 users.setPassword）
  void hashPassword

  const upstreamCache = new TtlCache<unknown>({
    maxEntries: config.upstreamCacheMaxSize,
    ttlMs: config.upstreamCacheTtlSec * 1000,
  })
  const upstream = new Upstream({ config, logger: logger.child('upstream'), cache: upstreamCache })
  const registry = new SourceRegistry()
  // 池运行时：设备表由 store 实现（DeviceStore 端口声明在 contract），启停由装配层负责
  const pools = createPoolRuntime({
    store: new DbPoolDevices(db),
    logger: logger.child('pool'),
    enabled: env['POOL_ENABLED'] === undefined ? true : !['0', 'false', 'off', 'no'].includes(String(env['POOL_ENABLED']).toLowerCase()),
  })
  const host = new SourceHost({
    pluginDir: config.pluginDir,
    logger: logger.child('host'),
    registry,
    pools,
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

  // 插件加载完再启动池（源的池声明在加载时登记，启动要等所有人就位）
  await pools.startAll()

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
    kv,
    pools,
    quotaExtra,
    sourceGroups,
  })
  return { config, app, db, host, registry, settings, dataSources, users, roles, plans, sessions, apiKeys, callLogs, quota, sourceConfigs, blockedIPs, devices, nameCache, schedules, kv, pools, quotaExtra, sourceGroups }
}
