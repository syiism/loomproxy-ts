// 三种信封（迁移-TS-1 §2）：控制面 / 数据面裸对象 / 带内错误。
// 数据面刻意不给信封类型——它就是裸 DTO，多包一层会改契约。

/** 控制面成功响应：{code:0,msg:"ok",data} */
export type OkEnvelope<T> = { code: 0; msg: 'ok'; data: T }

/** 控制面失败响应：{code:<ERROR_CODE>,msg}；code 取配置，不是 HTTP 状态码的副本 */
export type FailEnvelope = { code: number; msg: string }

export function ok<T>(data: T): OkEnvelope<T> {
  return { code: 0, msg: 'ok', data }
}

export function fail(errorCode: number, msg: string): FailEnvelope {
  return { code: errorCode, msg }
}

// 带内错误：HTTP 200 + contentType=error（Legado 书源传统写法）
// reason 的枚举是"建议值"，骨架只搬运不解释（迁移-TS-2 §5）。
export const IN_BAND_REASONS = [
  'upstream_network',
  'upstream_status',
  'pool_unavailable',
  'parse_empty',
  'unauthorized',
] as const
export type InBandReason = (typeof IN_BAND_REASONS)[number]

export type InBandErrorData = {
  message: string
  reason?: InBandReason | string
  code?: string
}
