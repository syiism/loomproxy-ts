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
  type SearchResponse,
} from '@loomproxy/contract'

type Loose = Record<string, unknown>

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? Math.trunc(n) : undefined
  }
  return undefined
}

export function observeCall(source: string, params: Params, result: unknown, subject: CallSubject): CallSubject {
  if (!result || typeof result !== 'object') return subject
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
    return subject
  }

  // detail：bookInfo / BookDetail
  const detail = r['bookInfo'] ?? r
  if (detail && typeof detail === 'object' && 'bookId' in (detail as Loose) && 'name' in (detail as Loose)) {
    const d = detail as BookDetail & Loose
    subject.book_name = d.name || subject.book_name
    subject.book_key = d.bookId || subject.book_key
    subject.result_count = 1
    subject.media = mediaFromBookTypeCode(d.bookTypeCode) || mediaFromContentType(d.bookType) || subject.media
    return subject
  }

  // chapter：chapterList
  if (Array.isArray(r['chapterList'])) {
    const c = result as ChapterResponse
    subject.result_count = c.chapterList.length
    return subject
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
      return subject
    }
    const content = c.data['content']
    subject.result_count = typeof content === 'string' && content !== '' ? 1 : 0
    return subject
  }

  void source
  return subject
}
