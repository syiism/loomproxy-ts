// 日志：等级 + 统一脱敏。错误文案里常内嵌签名 URL，日志层是最后一道闸。
import { scrubQuery } from '@loomproxy/contract'

export type LogLevel = 'debug' | 'info'

export type Logger = {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
  child(prefix: string): Logger
}

function render(v: unknown): unknown {
  if (typeof v === 'string') return scrubQuery(v)
  if (v instanceof Error) return scrubQuery(v.message)
  return v
}

/** 静默日志：测试与需要"只出 JSON"的场景用 */
export function silentLogger(): Logger {
  const noop = () => {}
  return { debug: noop, info: noop, warn: noop, error: noop, child: () => silentLogger() }
}

export function createLogger(level: LogLevel = 'info', prefix = ''): Logger {
  const tag = prefix ? `[${prefix}] ` : ''
  const emit = (lvl: LogLevel, consoleFn: 'log' | 'warn' | 'error') => (msg: string, ...args: unknown[]) => {
    if (lvl === 'debug' && level !== 'debug') return
    // biome-ignore lint/suspicious/noConsole: 这是日志出口本身
    console[consoleFn](`${tag}${scrubQuery(msg)}`, ...args.map(render))
  }
  return {
    debug: emit('debug', 'log'),
    info: emit('info', 'log'),
    warn: emit('info', 'warn'),
    error: emit('info', 'error'),
    child: (p: string) => createLogger(level, prefix ? `${prefix}:${p}` : p),
  }
}
