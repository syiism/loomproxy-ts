// 错误协议（迁移-TS-2 §5）：上游错误必须可判别、可映射状态码，不许退化成字符串匹配。

export class AppError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AppError'
  }
}

/** 上游非 2xx / 读取失败：statusCode 为上游码，0 表示"读/解析失败"这类未知异常 */
export class UpstreamError extends AppError {
  readonly statusCode: number
  constructor(statusCode: number, message: string, cause?: unknown) {
    super(message, cause)
    this.name = 'UpstreamError'
    this.statusCode = statusCode
  }
}

/** 客户端取消（对应 Go 的 context.Canceled）：出口静默，不写响应体 */
export class ClientCanceled extends AppError {
  constructor() {
    super('client canceled')
    this.name = 'ClientCanceled'
  }
}

export function isUpstreamError(e: unknown): e is UpstreamError {
  return e instanceof UpstreamError
}

// 脱敏：错误文案里常内嵌完整签名 URL（app_key/sig/device_sn），日志与下游都不得原样外泄。
const QUERY_RE = /\?[^\s"']+/g
export function scrubQuery(s: string): string {
  return s.replace(QUERY_RE, '?<redacted>')
}
