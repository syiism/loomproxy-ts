// 调用明细与聚合（迁移-TS-2 §8）。字段名与 Go 版 models.ApiCallLog 逐字对齐——
// 面板的历史页、筛选与导出都按这些名字读写。
//
// `plugin_version` 是 ④ §7 批准的第三格（2026-11-17）：热更新之后必须能回答
// "换成 1.1.0 之后错误率变了吗"，否则换代就是一次不可归因的改动。
// 加列 = 改契约：骨架仓的《观测契约-信封与明细字段》页要同批加这一列（跨仓待办）。
export type MediaTypeOrEmpty = 'novel' | 'audio' | 'comic' | 'video' | ''

export type CallLogRow = {
  id: number
  username: string
  ip: string
  source: string
  action: string
  status: number
  in_band_error: boolean
  in_band_reason: string
  in_band_code: string
  latency_ms: number
  created_at: string
  keyword: string
  book_name: string
  chapter_title: string
  book_ident: string
  chapter_ident: string
  media_type: MediaTypeOrEmpty
  result_count: number
  content_withheld: boolean
  /** 处理这次请求的插件版本（换代后可归因；空 = 不是插件路径/旧行） */
  plugin_version: string
}

/** 明细分页查询：与 Go 版 /admin/monitor/history 的 query 同名同义 */
export type CallLogQuery = {
  page: number
  pageSize: number
  source?: string
  action?: string
  username?: string
  pluginVersion?: string
  inBandCode?: string
  mediaType?: string
  /** 文本类做 contains（书名/章节名/搜索词），枚举类做等值 */
  keyword?: string
  bookName?: string
  chapterTitle?: string
}

export type CallLogPage = { total: number; page: number; page_size: number; list: CallLogRow[] }

/** 明细行的长度上限：上游书名/章节名可以很长，明细要保持有界（按 rune 截断） */
export const CALL_LOG_FIELD_MAX = { keyword: 128, bookName: 160, chapterTitle: 255, ident: 512 } as const
