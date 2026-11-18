// 观测抽取（迁移-TS-2 §8）：bookList/详情/目录/正文四路各抽自己那一格。
// 空串 = 这次没抽到，不是错误；两个"全空"靠 content_withheld 分开。
import {
  keywordOf,
  mediaFromBookTypeCode,
  mediaFromContentType,
  type CallSubject,
  type Params,
  type BookDetail,
  type ChapterResponse,
  type ContentResponse,
  type MediaOrEmpty,
  type SearchResponse,
} from '@loomproxy/contract'

type Loose = Record<string, unknown>

/** 源声明里的两处媒介（SourceMeta.media_type / SearchTab.media_type）；不传 = 源没声明 */
export type ObserveDecl = {
  media?: MediaOrEmpty | undefined
  searchTabs?: ReadonlyArray<{ tab_type: number; media_type?: MediaOrEmpty | undefined }> | undefined
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? Math.trunc(n) : undefined
  }
  return undefined
}

// 请求里的 tab 参数：Legado 叫 tabType，历史写法还有 tab_type / searchType（Go 的 MediaFromSearchTab 同口径）
const TAB_PARAM_NAMES = ['tabType', 'tab_type', 'searchType'] as const

function tabMedia(params: Params, decl: ObserveDecl): MediaOrEmpty {
  const tabs = decl.searchTabs ?? []
  if (tabs.length === 0) return ''
  const raw = TAB_PARAM_NAMES.map((k) => params[k]).find((v) => typeof v === 'string' && v.trim() !== '')
  if (raw === undefined) return ''
  const want = raw.trim()
  for (const t of tabs) if (String(t.tab_type) === want) return t.media_type ?? ''
  return ''
}

/**
 * 媒介判定优先级（与 Go `base/legado/observe.go` 的 resolveMedia 逐步对齐）：
 * ① 响应自带（条目的 bookTypeCode / 详情的 bookType / 正文的 contentType）
 * ② 请求 tab 命中的源声明（SearchTab.media_type）
 * ③ 源默认声明（SourceMeta.media_type）
 * ④ 都没有 = 空串（未判定）——被拦掉的请求从没触及内容，不该伪装成一个类型
 *
 * 缺了 ②③ 的后果不是"少一列"：面板按媒介筛选、覆盖率体检、内容榜都读这一格，
 * 单媒介源（声明了 media_type 却永远显示"未判定"）就是这么来的。
 * 唯一没搬的一档是 Go 的 ③″「命名缓存里这本书此前的判定」：本仓的 name_cache 只存名字，
 * 不存媒介（多存一列的收益要等有真正的多媒介源再说）。
 */
function finish(subject: CallSubject, params: Params, decl: ObserveDecl): CallSubject {
  if (!subject.media) subject.media = tabMedia(params, decl) || decl.media || ''
  return subject
}

export function observeCall(
  source: string,
  params: Params,
  result: unknown,
  subject: CallSubject,
  decl: ObserveDecl = {},
): CallSubject {
  if (!result || typeof result !== 'object') return finish(subject, params, decl)
  const r = result as Loose

  // search / explore：bookList
  if (Array.isArray(r['bookList'])) {
    const list = r['bookList'] as Loose[]
    subject.keyword = keywordOf(params)
    subject.result_count = list.length
    const first = list[0]
    if (first && !subject.media) {
      const code = num(first['bookTypeCode'])
      if (code !== undefined) subject.media = mediaFromBookTypeCode(code)
    }
    return finish(subject, params, decl)
  }

  // detail：bookInfo / BookDetail
  const detail = r['bookInfo'] ?? r
  if (detail && typeof detail === 'object' && 'bookId' in (detail as Loose) && 'name' in (detail as Loose)) {
    const d = detail as BookDetail & Loose
    subject.book_name = d.name || subject.book_name
    subject.book_key = d.bookId || subject.book_key
    subject.result_count = 1
    subject.media = mediaFromBookTypeCode(d.bookTypeCode) || mediaFromContentType(d.bookType) || subject.media
    return finish(subject, params, decl)
  }

  // chapter：chapterList
  if (Array.isArray(r['chapterList'])) {
    const c = result as ChapterResponse
    subject.result_count = c.chapterList.length
    return finish(subject, params, decl)
  }

  // content：正文
  if (typeof r['contentType'] === 'string') {
    const c = result as ContentResponse
    const media = mediaFromContentType(c.contentType)
    if (media) subject.media = media
    if (c.contentType === 'error') {
      subject.in_band_error = true
      const data = c.data as Loose
      const reason = data['reason']
      const code = data['code']
      if (typeof reason === 'string') subject.in_band_reason = reason
      if (code !== undefined && code !== null) subject.in_band_code = String(code)
      subject.result_count = 0
      return finish(subject, params, decl)
    }
    const content = c.data['content']
    subject.result_count = typeof content === 'string' && content !== '' ? 1 : 0
    return finish(subject, params, decl)
  }

  void source
  return finish(subject, params, decl)
}
