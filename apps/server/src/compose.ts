// 装配的纯函数版：main.ts 与 e2e 用例共用同一条装配路径（避免"测试跑的不是线上的装配"）。
import { join } from 'node:path'
import { TtlCache, Upstream, createLogger, loadConfig, silentLogger, type Config, type Logger } from '@loomproxy/kernel'
import { randomBytes } from 'node:crypto'
import { EnvAdminUser, InMemoryCallLogs, InMemoryDataSources, InMemorySettings } from '@loomproxy/store'
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
  host: SourceHost
  registry: SourceRegistry
  settings: InMemorySettings
  dataSources: InMemoryDataSources
  users: EnvAdminUser
  callLogs: InMemoryCallLogs
}

export async function compose(opts: ComposeOptions = {}): Promise<Composed> {
  // env 只读一次：配置加载与账号初始化必须看同一份（否则注入给测试的 ADMIN_PASSWORD 读不到自己）
  const env = opts.env ?? process.env
  const config = loadConfig(env)
  const logger = opts.logger ?? createLogger(config.serverLogLevel, 'loomproxy')
  for (const w of config.warnings) logger.warn(w)

  const settings = new InMemorySettings({ filePath: join(config.dataDir, 'settings.json') })
  const dataSources = new InMemoryDataSources()
  const callLogs = new InMemoryCallLogs({ max: 5_000 })
  // 单管理员：密码来自 ADMIN_PASSWORD；没配就随机生成并在启动日志里说一次（否则没人能登面板）
  const generated = config.authEnabled && !env['ADMIN_PASSWORD'] ? randomBytes(9).toString('base64url') : ''
  const users = new EnvAdminUser(env['ADMIN_USERNAME'] ?? 'admin', env['ADMIN_PASSWORD'] ?? '', {
    randomPassword: generated,
  })
  if (generated) logger.warn(`未设置 ADMIN_PASSWORD，本次生成的登录密码是：${generated}（用户名 ${users.username}）`)
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
  logger.info(`插件扫描完成：${infos.length} 个（active=${infos.filter((i) => i.state === 'active').length}）`)

  const app = buildServer({
    config,
    logger: logger.child('api'),
    upstream,
    host,
    dataSources,
    settings,
    users,
    callLogs,
  })
  return { config, app, host, registry, settings, dataSources, users, callLogs }
}

void silentLogger
