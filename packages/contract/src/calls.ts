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

// ==== 内容维度榜（阅读记录） ====
// 形状与 Go 的 subjectrank.Item 逐字对齐：管理端「监控 → 内容维度」与公开「排行榜」
// 读的是同一份聚合，只是字段收窄（公开榜只发 name/total/book_id）。
// **两个数字不同义**：visitors 是同数据源内按访问者去重的「人数」，requests 是调用条数；
// total 是排名用的那个数（书名维度取人数，其余取条数）——一个字段兼表两义就是把口径藏起来。

/** 维度白名单：章节名颗粒度太细，只给管理端；公开榜只有 keyword/book */
export const SUBJECT_DIMS = ['keyword', 'book', 'chapter', 'media'] as const
export type SubjectDim = (typeof SUBJECT_DIMS)[number]

export function isValidSubjectDim(v: string): v is SubjectDim {
  return (SUBJECT_DIMS as readonly string[]).includes(v)
}

export type SubjectQuery = {
  dim: SubjectDim
  days: number
  /** 只看某个源（空 = 全部） */
  source?: string
  /** 只看某种媒介（空 = 全部；"未判定"不属任何单一媒介） */
  media?: string
  /** 最多回多少条（<=0 = 不截断） */
  limit?: number
  /** 公开榜的源白名单：非 undefined 即把统计范围钉死在这份名单内（空数组 = 零个源可见） */
  allowSources?: string[]
}

/**
 * store 层入参：窗口起点由调用方按时区日界算好传进来（时区只有 kernel 一处定义，
 * 写照 "days-1 天前的当日零点"，不在这里各算一遍）。
 */
export type SubjectWindowQuery = Omit<SubjectQuery, 'days'> & { since: string }

export type SubjectItem = {
  name: string
  /** 媒介维度的中文名（其余维度不带） */
  label?: string
  /** 排名数字：书名维度=人数，其余=请求数 */
  total: number
  visitors: number
  requests: number
  success: number
  failed: number
  success_rate: number
  avg_latency_ms: number
  max_latency_ms: number
  empty_results: number
  sources: string[]
  last_called_at?: string
  /** 只在书名维度：该书最近一条非空标识（检索用，面板不展示） */
  book_id?: string
}

/** 自我观测：哪一格没采到，该由系统说，而不是靠人肉写 SQL 去猜 */
export type SubjectCoverageRow = {
  source: string
  action: string
  rows: number
  has_book_name: number
  has_book_ident: number
  has_chapter_title: number
  has_media: number
  failed: number
  in_band_failed: number
  /** 用户自己关掉了留存——它不进分母，标红都不是缺陷 */
  withheld: number
  /** search/explore 本就没有"这一本"，空不是缺陷 */
  expect_book: boolean
}

/** 公开榜的榜单定义（标题/单位/口径写在这里，面板不再各抄一份） */
export const RANK_BOARDS = [
  { dim: 'keyword', title: '搜索热词榜', unit: '次', metric: '搜索次数' },
  { dim: 'book', title: '阅读榜', unit: '人', metric: '访问人数（同数据源内按用户去重）' },
] as const

export type RankBoard = {
  dim: string
  title: string
  unit: string
  metric: string
  rows: Array<{ name: string; total: number; book_id?: string }>
}
