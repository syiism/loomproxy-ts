// 装配的纯函数版：main.ts 与 e2e 用例共用同一条装配路径（避免"测试跑的不是线上的装配"）。
import { join } from 'node:path'
import { TtlCache, Upstream, createLogger, loadConfig, silentLogger, type Config, type Logger } from '@loomproxy/kernel'
import { InMemoryDataSources, InMemorySettings } from '@loomproxy/store'
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
}

export async function compose(opts: ComposeOptions = {}): Promise<Composed> {
  const config = loadConfig(opts.env ?? process.env)
  const logger = opts.logger ?? createLogger(config.serverLogLevel, 'loomproxy')
  for (const w of config.warnings) logger.warn(w)

  const settings = new InMemorySettings({ filePath: join(config.dataDir, 'settings.json') })
  const dataSources = new InMemoryDataSources()
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
  })
  return { config, app, host, registry, settings, dataSources }
}

void silentLogger
