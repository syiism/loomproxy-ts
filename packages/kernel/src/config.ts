// 配置唯一出口（迁移-TS-2 §9）：键名与默认值与 Go 版 conf.Load 逐字一致。
// 三条硬规矩：默认值不许改、读键只有这一处、源专属键不进这里。
// 非法值必须出声（badEnvNotes）——历史上 AUTH_ENABLED=1 被读成 false，"以为开了鉴权"就是这么来的。
export type Config = {
  timeoutConnectMs: number
  timeoutPoolMs: number
  cacheTtlSec: number
  cacheMaxSize: number
  upstreamCacheTtlSec: number
  upstreamCacheMaxSize: number
  upstreamCacheStaleMult: number
  circuitBreakerEnabled: boolean
  circuitBreakerFailures: number
  circuitBreakerCooldownSec: number
  upstreamProxies: string[]
  upstreamProxyFile: string
  upstreamUaRotate: boolean
  serverHost: string
  serverPort: number
  serverLogLevel: 'debug' | 'info'
  tzOffsetHours: number
  errorCode: number
  dataDir: string
  dataFileGlob: string
  monitorRetentionDays: number
  billingDedupeSec: number
  rankCacheSec: number
  authEnabled: boolean
  apiKeys: string[]
  authWhitelist: string[]
  jwtSecret: string
  jwtExpireHours: number
  dbType: string
  pluginDir: string
  /** 注册表换代计数进 /datasources 缓存键（否则"加载了新源但清单里没有"） */
  warnings: string[]
}

const DEFAULTS = {
  TIMEOUT_CONNECT: '5',
  TIMEOUT_POOL: '10',
  CACHE_TTL: '300',
  CACHE_MAXSIZE: '128',
  UPSTREAM_CACHE_TTL: '10',
  UPSTREAM_CACHE_MAXSIZE: '512',
  UPSTREAM_CACHE_STALE_MULT: '3',
  CIRCUIT_BREAKER_ENABLED: 'true',
  CIRCUIT_BREAKER_FAILURES: '5',
  CIRCUIT_BREAKER_COOLDOWN: '30',
  UPSTREAM_PROXY_FILE: '',
  UPSTREAM_UA_ROTATE: 'false',
  SERVER_HOST: '0.0.0.0',
  SERVER_PORT: '8081',
  SERVER_LOG_LEVEL: 'info',
  TZ_OFFSET_HOURS: '8',
  ERROR_CODE: '-1',
  DATA_DIR: 'data',
  DB_TYPE: 'mysql',
  DATA_FILE_GLOB: '*.json',
  MONITOR_RETENTION_DAYS: '0',
  BILLING_DEDUPE_SEC: '300',
  RANK_CACHE_SEC: '60',
  AUTH_ENABLED: 'false',
  JWT_SECRET: 'loomproxy-default-secret-change-me',
  JWT_EXPIRE_HOURS: '168',
  PLUGIN_DIR: 'plugins',
} as const

export const DEFAULT_JWT_SECRET = DEFAULTS.JWT_SECRET

type Env = Record<string, string | undefined>

function reader(env: Env, warnings: string[]) {
  const raw = (key: keyof typeof DEFAULTS): string => {
    const v = env[key]
    return v === undefined || v === '' ? DEFAULTS[key] : v
  }
  return {
    str(key: keyof typeof DEFAULTS): string {
      return raw(key).trim()
    },
    int(key: keyof typeof DEFAULTS): number {
      const s = raw(key).trim()
      const n = Number(s)
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        warnings.push(`${key}=${JSON.stringify(s)} 不是整数，已按默认值 ${DEFAULTS[key]} 处理`)
        return Number(DEFAULTS[key])
      }
      return n
    },
    float(key: keyof typeof DEFAULTS): number {
      const s = raw(key).trim()
      const n = Number(s)
      if (!Number.isFinite(n)) {
        warnings.push(`${key}=${JSON.stringify(s)} 不是数字，已按默认值 ${DEFAULTS[key]} 处理`)
        return Number(DEFAULTS[key])
      }
      return n
    },
    bool(key: keyof typeof DEFAULTS): boolean {
      const s = raw(key).trim().toLowerCase()
      if (['1', 'true', 'yes', 'on'].includes(s)) return true
      if (['0', 'false', 'no', 'off'].includes(s)) return false
      warnings.push(`${key}=${JSON.stringify(raw(key))} 不是布尔值，已按默认值 ${DEFAULTS[key]} 处理`)
      return DEFAULTS[key] === 'true'
    },
    list(key: string, def: string): string[] {
      const v = env[key]
      const s = v === undefined || v === '' ? def : v
      return s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    },
  }
}

/**
 * 读配置。`env` 由调用方传入（`apps/server` 负责先加载 .env），
 * 这样本层不需要知道 .env 在哪、也不会在测试里被真实环境污染。
 */
export function loadConfig(env: Env = process.env): Config {
  const warnings: string[] = []
  const r = reader(env, warnings)
  const logLevel = r.str('SERVER_LOG_LEVEL') === 'debug' ? 'debug' : 'info'
  const cfg: Config = {
    timeoutConnectMs: r.float('TIMEOUT_CONNECT') * 1000,
    timeoutPoolMs: r.float('TIMEOUT_POOL') * 1000,
    cacheTtlSec: r.int('CACHE_TTL'),
    cacheMaxSize: r.int('CACHE_MAXSIZE'),
    upstreamCacheTtlSec: r.float('UPSTREAM_CACHE_TTL'),
    upstreamCacheMaxSize: r.int('UPSTREAM_CACHE_MAXSIZE'),
    upstreamCacheStaleMult: r.float('UPSTREAM_CACHE_STALE_MULT'),
    circuitBreakerEnabled: r.bool('CIRCUIT_BREAKER_ENABLED'),
    circuitBreakerFailures: r.int('CIRCUIT_BREAKER_FAILURES'),
    circuitBreakerCooldownSec: r.float('CIRCUIT_BREAKER_COOLDOWN'),
    upstreamProxies: r.list('UPSTREAM_PROXIES', ''),
    upstreamProxyFile: r.str('UPSTREAM_PROXY_FILE'),
    upstreamUaRotate: r.bool('UPSTREAM_UA_ROTATE'),
    serverHost: r.str('SERVER_HOST'),
    serverPort: r.int('SERVER_PORT'),
    serverLogLevel: logLevel,
    tzOffsetHours: r.int('TZ_OFFSET_HOURS'),
    errorCode: r.int('ERROR_CODE'),
    dataDir: r.str('DATA_DIR'),
    dataFileGlob: r.str('DATA_FILE_GLOB'),
    monitorRetentionDays: r.int('MONITOR_RETENTION_DAYS'),
    billingDedupeSec: r.int('BILLING_DEDUPE_SEC'),
    rankCacheSec: r.int('RANK_CACHE_SEC'),
    authEnabled: r.bool('AUTH_ENABLED'),
    apiKeys: r.list('API_KEYS', ''),
    authWhitelist: r.list('AUTH_WHITELIST', '/,/data,/auth/register,/auth/login,/panel'),
    jwtSecret: r.str('JWT_SECRET'),
    jwtExpireHours: r.int('JWT_EXPIRE_HOURS'),
    dbType: r.str('DB_TYPE'),
    pluginDir: r.str('PLUGIN_DIR'),
    warnings,
  }
  // 生产环境（启用鉴权）强制要求改默认 JWT_SECRET（Go 版同口径：直接拒绝启动）
  if (cfg.authEnabled && cfg.jwtSecret === DEFAULT_JWT_SECRET) {
    throw new Error('SECURITY ERROR: JWT_SECRET 使用默认值，生产环境必须设置强随机密钥')
  }
  return cfg
}

/** .env 解析：**已存在的真实环境变量优先**（不覆盖），值两端引号被剥离 */
export function parseDotEnv(text: string, base: Env = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    const key = t.slice(0, i).trim()
    let value = t.slice(i + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key && (base[key] === undefined || base[key] === '')) out[key] = value
  }
  return out
}
