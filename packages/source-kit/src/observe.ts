// 观测抽取（迁移-TS-2 §8）：bookList/详情/目录/正文四路各抽自己那一格，
// 并把「标识 → 名称」写进命名缓存，供后续只带标识的请求反查（这就是面板说的「阅读记录」）。
// 空串 = 这次没抽到，不是错误；两个"全空"靠 content_withheld 分开。
import {
  clipSubject,
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

/**
 * 命名缓存的端口（结构上与 store 的 DbNameCache 相同）。
 * source-kit 不许 import store（分层），所以这里只声明形状。
 */
export type NameCachePort = {
  rememberBook(source: string, ident: string, name: string): void
  rememberChapter(source: string, bookIdent: string, ident: string, title: string): void
  lookupBook(source: string, ident: string): string
  lookupChapter(source: string, bookIdent: string, ident: string): string
}

export type ObserveDeps = {
  /** 源声明（媒介兜底；声明位是唯一事实来源，平台不另抄一份映射表） */
  decl?: ObserveDecl | undefined
  /** 名称缓存：带上它才会「搜索/目录攒名字、正文/目录回填名字」 */
  nameCache?: NameCachePort | undefined
  /** 用户关掉了留存：形状识别照跑（成没成要留在读数里），但写缓存一律跳过 */
  withheld?: boolean | undefined
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? Math.trunc(n) : undefined
  }
  return undefined
}

// 标识参数名多写法兼容：不同源的参数习惯不一（Go 的 ParamString(params, "bookId", "book_id", "id", "bookUrl") 同口径）。
// 只认 string 会静默丢成空串——上游与下游的标识可能是数字。
const BOOK_KEY_NAMES = ['bookId', 'book_id', 'id', 'bookUrl'] as const
const CHAPTER_KEY_NAMES = ['itemId', 'item_id', 'chapterUrl', 'chapter_url', 'url'] as const
// 请求里的 tab 参数：Legado 叫 tabType，历史写法还有 tab_type / searchType
const TAB_PARAM_NAMES = ['tabType', 'tab_type', 'searchType'] as const

function firstParam(params: Params, names: readonly string[]): string {
  for (const k of names) {
    const v = params[k]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return ''
}

/** 章标识里可能带着书标识（"bookId|itemId" 或带 bookId= 的 URL）——Go 的 BookIdentFromChapterKey 同口径 */
function bookFromChapterKey(gotChapterKey: string): string {
  if (!gotChapterKey) return ''
  const bar = gotChapterKey.indexOf('|')
  if (bar > 0) return gotChapterKey.slice(0, bar)
  for (const qk of ['bookId', 'book_id', 'bid', 'bookid']) {
    const m = new RegExp(`[?&]${qk}=([^&#]+)`).exec(gotChapterKey)
    if (m?.[1]) return decodeURIComponent(m[1])
  }
  return ''
}

function tabMedia(params: Params, decl: ObserveDecl): MediaOrEmpty {
  const tabs = decl.searchTabs ?? []
  if (tabs.length === 0) return ''
  const raw = TAB_PARAM_NAMES.map((k) => params[k]).find((v) => typeof v === 'string' && v.trim() !== '')
  if (raw === undefined) return ''
  const want = raw.trim()
  for (const t of tabs) if (String(t.tab_type) === want) return t.media_type ?? ''
  return ''
}

/** 条目里的媒介：显式类型码优先，其次类型名（与 Go 的 mediaOfItem 同口径） */
function mediaOfItem(item: Loose): MediaOrEmpty {
  const code = num(item['bookTypeCode'])
  if (code !== undefined) {
    const m = mediaFromBookTypeCode(code)
    if (m) return m
  }
  return ''
}

/** 书名/章节名/搜索词一律按 rune 截断（clipSubject），写缓存前先截——别把 300 字的标题塞进键 */
function finish(source: string, subject: CallSubject, params: Params, deps: ObserveDeps): CallSubject {
  const decl = deps.decl ?? {}
  const cache = deps.nameCache
  // 书标识：参数里没有就从章标识里拆（正文请求常只带 itemId）
  if (!subject.book_key) subject.book_key = bookFromChapterKey(subject.chapter_key)
  // 媒介判定链（Go resolveMedia 的 ②③ 两档；④ = 留空"未判定"是合法状态）
  if (!subject.media) subject.media = tabMedia(params, decl) || decl.media || ''
  // 名称回填：正文/目录只带标识，书名与章节名靠缓存反查——这就是「阅读记录」能读出书名的那一步
  if (cache) {
    if (!subject.book_name && subject.book_key) subject.book_name = cache.lookupBook(source, subject.book_key) || subject.book_name
    if (!subject.chapter_title && subject.book_key && subject.chapter_key) {
      subject.chapter_title = cache.lookupChapter(source, subject.book_key, subject.chapter_key) || subject.chapter_title
    }
  }
  // 原地收口（去空白 + 按 rune 截断）：detail hook 拿的是同一个对象引用，替换成新对象会丢
  Object.assign(subject, clipSubject(subject))
  return subject
}

/** 写缓存：滑动窗口那一档（withheld）时必须跳过，否则"当场说不捕获、下一轮被自己补回来" */
function rememberBooks(source: string, list: Loose[], bookKey: string, deps: ObserveDeps): void {
  const cache = deps.nameCache
  if (!cache || deps.withheld) return
  for (const it of list) {
    const ident = firstParam(it as unknown as Params, BOOK_KEY_NAMES) || bookKey
    const name = String(it['name'] ?? it['bookName'] ?? it['title'] ?? '')
    cache.rememberBook(source, ident, name)
  }
}

function rememberChapters(source: string, list: Loose[], bookKey: string, deps: ObserveDeps): void {
  const cache = deps.nameCache
  if (!cache || deps.withheld || !bookKey) return
  for (const it of list) {
    const ident = firstParam(it as unknown as Params, CHAPTER_KEY_NAMES)
    const title = String(it['title'] ?? it['n'] ?? it['name'] ?? '')
    cache.rememberChapter(source, bookKey, ident, title)
  }
}

export function observeCall(
  source: string,
  params: Params,
  result: unknown,
  subject: CallSubject,
  deps: ObserveDeps = {},
): CallSubject {
  // 标识先落：目录/正文只带标识，回填与缓存写入都靠它；被拦掉的请求（没进 handler）根本不走这里
  subject.book_key = subject.book_key || firstParam(params, BOOK_KEY_NAMES)
  subject.chapter_key = subject.chapter_key || firstParam(params, CHAPTER_KEY_NAMES)

  if (!result || typeof result !== 'object') return finish(source, subject, params, deps)
  const r = result as Loose

  // search / explore：bookList
  if (Array.isArray(r['bookList'])) {
    const list = r['bookList'] as Loose[]
    subject.keyword = keywordOf(params)
    subject.result_count = list.length
    const first = list[0]
    if (first && !subject.media) subject.media = mediaOfItem(first)
    // 搜索结果里的书名灌进缓存：用户看完列表就会点进某本书，之后 info/chapter/content
    // 只带标识，靠这里攒下的名字才能把明细标出来
    rememberBooks(source, list, subject.book_key, deps)
    return finish(source, subject, params, deps)
  }

  // detail：bookInfo / BookDetail
  const detail = r['bookInfo'] ?? r
  if (detail && typeof detail === 'object' && 'bookId' in (detail as Loose) && 'name' in (detail as Loose)) {
    const d = detail as BookDetail & Loose
    subject.book_name = d.name || subject.book_name
    subject.book_key = d.bookId || subject.book_key
    subject.result_count = 1
    subject.media = mediaFromBookTypeCode(d.bookTypeCode) || mediaFromContentType(d.bookType) || subject.media
    if (!deps.withheld && deps.nameCache && subject.book_key && subject.book_name) {
      deps.nameCache.rememberBook(source, subject.book_key, subject.book_name)
    }
    return finish(source, subject, params, deps)
  }

  // chapter：chapterList（章节名进缓存：正文请求只带 itemId，章名靠这里反查）
  if (Array.isArray(r['chapterList'])) {
    const c = result as ChapterResponse
    subject.result_count = c.chapterList.length
    rememberChapters(source, c.chapterList as unknown as Loose[], subject.book_key, deps)
    return finish(source, subject, params, deps)
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
      return finish(source, subject, params, deps)
    }
    const content = c.data['content']
    subject.result_count = typeof content === 'string' && content !== '' ? 1 : 0
    return finish(source, subject, params, deps)
  }

  void source
  return finish(source, subject, params, deps)
}