// 调用明细的请求级上下文 + 出口记账（对应 Go 的 monitor 中间件"c.Next() 之后"那一半）。
// 用 WeakMap 而不是往 request 上挂字段：不用 module augmentation，也不会随请求泄漏。
import type { FastifyRequest } from 'fastify'
import type { CallSubject, CallLogRow, Params } from '@loomproxy/contract'

export type CallMeta = {
  source: string
  action: string
  params: Params
  username: string
  ip: string
  startedAt: number
  pluginVersion: string
  subject: CallSubject
}

const metas = new WeakMap<FastifyRequest, CallMeta>()

export function trackCall(req: FastifyRequest, meta: CallMeta): void {
  metas.set(req, meta)
}

export function callMetaOf(req: FastifyRequest): CallMeta | undefined {
  return metas.get(req)
}

/** 一次请求 → 一行明细。status/耗时取出口看到的真实值（含 4xx/5xx，Go 同口径）。 */
export function toCallLogRow(meta: CallMeta, status: number, nowIso: string): Omit<CallLogRow, 'id'> {
  const s = meta.subject
  return {
    username: meta.username,
    ip: meta.ip,
    source: meta.source,
    action: meta.action,
    status,
    in_band_error: s.in_band_error,
    in_band_reason: s.in_band_reason,
    in_band_code: s.in_band_code,
    latency_ms: Date.now() - meta.startedAt,
    created_at: nowIso,
    keyword: s.keyword,
    book_name: s.book_name,
    chapter_title: s.chapter_title,
    // 标识从 subject 取而不是从请求参数取：用户关掉留存后 withholdContent 会把标识一起抹掉，
    // 直接抄 params 等于给它留了第五面（明细照旧带着"他读了哪本书"）。
    book_ident: s.book_key,
    chapter_ident: s.chapter_key,
    media_type: s.media,
    result_count: s.result_count,
    content_withheld: s.content_withheld,
    plugin_version: meta.pluginVersion,
  }
}
