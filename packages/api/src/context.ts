// 一次请求的上下文：链上每一段只往这里添自己那一格，handler 不读 HTTP 对象。
import type { CallSubject, Params } from '@loomproxy/contract'
import type { Identity } from './auth.ts'

export type RequestContext = {
  source: string
  action: string
  params: Params
  identity: Identity
  ip: string
  requestId: string
  /** 用户级 baseUrl 解析结果（FixedBaseURL 的源不消费） */
  baseUrl: string
  subject: CallSubject
  /** 监控口径：这次是带内失败还是真成功 */
  status: number
  userId?: number
}
