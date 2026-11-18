import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceRegistry } from '../src/registry.ts'
import { defineSource } from '../src/handler.ts'
import { stampSearchSource } from '../src/present.ts'
import { observeCall, type NameCachePort, type ObserveDecl } from '../src/observe.ts'
import { newSubject, withholdContent } from '@loomproxy/contract'

const meta = {
  code: 'demo',
  display: '演示',
  category: 'demo',
  sort_order: 1,
  status: 1,
  actions: ['search', 'content'] as const,
  fixed_base_url: false,
}

test('注册表：换代是原子替换，且在飞请求拿到的是"它进门前的那一代"', () => {
  const reg = new SourceRegistry()
  const v1 = defineSource({ handlers: { search: async () => ({ bookList: [], v: 1 }) } })
  const v2 = defineSource({ handlers: { search: async () => ({ bookList: [], v: 2 }) } })
  reg.swap({ code: 'demo', meta: { ...meta, actions: ['search'] }, version: '1.0.0', isolation: 'in-process', state: 'active', def: v1 })

  const inflight = reg.resolve('demo', 'search')
  assert.ok(inflight)

  reg.swap({ code: 'demo', meta: { ...meta, actions: ['search'] }, version: '1.1.0', isolation: 'in-process', state: 'active', def: v2 })
  const after = reg.resolve('demo', 'search')
  assert.ok(after)
  assert.notEqual(inflight!.entry.generation, after!.entry.generation)
  // 老代仍然可用（draining 期间必须能跑完）
  assert.equal(inflight!.entry.version, '1.0.0')
  assert.equal(after!.entry.version, '1.1.0')
})

test('注册表：failed/disabled 不可被派发；未声明的动作回 undefined', () => {
  const reg = new SourceRegistry()
  const def = defineSource({ handlers: { search: async () => ({ bookList: [] }) } })
  reg.swap({ code: 'demo', meta: { ...meta, actions: ['search'] }, version: '1', isolation: 'in-process', state: 'active', def })
  assert.ok(reg.resolve('demo', 'search'))
  assert.equal(reg.resolve('demo', 'content'), undefined, '没实现的动作不许派发')
  reg.setState('demo', 'disabled')
  assert.equal(reg.resolve('demo', 'search'), undefined)
})

test('defineSource 注册期校验：空 handler 表直接失败', () => {
  assert.throws(() => defineSource({ handlers: {} }), /至少要有一个 handler/)
})

test('search 打标：source 与 kind 首项都写源码，旧 kind 里的错源码被剔掉', () => {
  const out = stampSearchSource(
    { bookList: [{ bookId: '1', name: 'n', author: 'a', kind: 'wrong,小说', wordCount: '', lastChapter: '', intro: '', coverUrl: '' }] },
    'demo',
  ) as { bookList: Array<{ source: string; kind: string }> }
  assert.equal(out.bookList[0]!.source, 'demo')
  assert.equal(out.bookList[0]!.kind, 'demo,wrong,小说', '源码放首位，其它标签原样保留')
})

test('观测抽取：四路各抽自己那一格；带内错误只标观测、不改正文', () => {
  const s = newSubject()
  observeCall('demo', { key: '三体' }, { bookList: [{ bookTypeCode: 2 }] }, s)
  assert.equal(s.keyword, '三体')
  assert.equal(s.result_count, 1)
  assert.equal(s.media, 'audio')

  const d = newSubject()
  observeCall('demo', {}, { bookId: 'b1', name: '书名', bookTypeCode: 0 }, d)
  assert.equal(d.book_name, '书名')
  assert.equal(d.media, 'novel')

  const c = newSubject()
  observeCall('demo', {}, { chapterList: [{}, {}] }, c)
  assert.equal(c.result_count, 2)

  const body = newSubject()
  observeCall('demo', {}, { contentType: 'audio', data: { content: 'https://x/a.mp3' } }, body)
  assert.equal(body.media, 'audio')
  assert.equal(body.result_count, 1)

  const err = observeCall('demo', {}, { contentType: 'error', data: { message: 'm', reason: 'upstream_network', code: '429' } }, newSubject())
  assert.equal(err.in_band_error, true)
  assert.equal(err.in_band_reason, 'upstream_network')
  assert.equal(err.in_band_code, '429')
  assert.equal(err.result_count, 0)

  const withheld = withholdContent(err)
  assert.equal(withheld.content_withheld, true)
  assert.equal(withheld.in_band_reason, 'upstream_network')
})

test('媒介判定链：响应自带 → 请求 tab 声明 → 源默认声明 → 空（未判定）', () => {
  const decl: ObserveDecl = {
    media: 'novel',
    searchTabs: [
      { tab_type: 3, media_type: 'novel' },
      { tab_type: 4, media_type: 'comic' },
    ],
  }

  // ① 响应自带优先（单条目的类型字段大过源默认声明）
  const own = observeCall('demo', { key: 'x' }, { bookList: [{ bookTypeCode: 2 }] }, newSubject(), { decl })
  assert.equal(own.media, 'audio')

  // ② 响应没给 → 请求 tab 命中的声明（多媒介源：同一源不同 tab 不同形态）
  const tab = observeCall('demo', { key: 'x', tabType: '4' }, { bookList: [{}] }, newSubject(), { decl })
  assert.equal(tab.media, 'comic')

  // ③ tab 没命中（或请求没带 tab）→ 源默认声明；这才是单媒介源的真实现场
  const def = observeCall('demo', { key: 'x' }, { bookList: [{}] }, newSubject(), { decl })
  assert.equal(def.media, 'novel')
  const list = observeCall('demo', { key: 'x', tabType: '9' }, { bookList: [{}] }, newSubject(), { decl })
  assert.equal(list.media, 'novel', 'tab 参数命中不到任何声明时回落到默认')

  // ④ 什么都没声明 → 空串（未判定是合法状态，不许编一个类型出来）
  const none = observeCall('demo', { key: 'x' }, { bookList: [{}] }, newSubject())
  assert.equal(none.media, '')

  // 目录与正文同样吃声明兜底（正文 contentType 自己给了就以它为准）
  const chapter = observeCall('demo', {}, { chapterList: [{}] }, newSubject(), { decl })
  assert.equal(chapter.media, 'novel')
  const body = observeCall('demo', {}, { contentType: 'audio', data: { content: 'x' } }, newSubject(), { decl })
  assert.equal(body.media, 'audio')
})

test('阅读记录：列表攒名字、正文按标识回填；关掉留存则连缓存写口一起跳过', () => {
  const mem = new Map<string, string>()
  const cache: NameCachePort = {
    rememberBook: (src, ident, name) => { if (ident && name) mem.set(`b:${src}:${ident}`, name) },
    rememberChapter: (src, book, ident, title) => { if (book && ident && title) mem.set(`c:${src}:${book}|${ident}`, title) },
    lookupBook: (src, ident) => mem.get(`b:${src}:${ident}`) ?? '',
    lookupChapter: (src, book, ident) => mem.get(`c:${src}:${book}|${ident}`) ?? '',
  }

  // 搜索列表：每条的书名都要进缓存（用户接下来点开的就是其中一本）
  observeCall('demo', { key: '三体' }, { bookList: [{ bookId: 'b1', name: '三体' }, { bookId: 'b2', name: '黑暗森林' }] }, newSubject(), { nameCache: cache })
  assert.equal(cache.lookupBook('demo', 'b2'), '黑暗森林')
  // 目录：章节名按「书+章」进缓存
  observeCall('demo', { bookId: 'b1' }, { chapterList: [{ itemId: 'c1', title: '第一章' }] }, newSubject(), { nameCache: cache })
  assert.equal(cache.lookupChapter('demo', 'b1', 'c1'), '第一章')
  // 正文只带标识：书名与章名都要回填出来，标识也要落进 subject（明细的 book_ident/chapter_ident 取它）
  const body = newSubject()
  observeCall('demo', { bookId: 'b1', itemId: 'c1' }, { contentType: 'novel', data: { content: '正文' } }, body, { nameCache: cache })
  assert.equal(body.book_key, 'b1')
  assert.equal(body.chapter_key, 'c1')
  assert.equal(body.book_name, '三体')
  assert.equal(body.chapter_title, '第一章')
  assert.equal(body.result_count, 1)

  // 详情：书名进缓存（同一本书换个源进来只带 id 时也能标出来）
  observeCall('demo', { bookId: 'b3' }, { bookId: 'b3', name: '死神永生', bookTypeCode: 0 }, newSubject(), { nameCache: cache })
  assert.equal(cache.lookupBook('demo', 'b3'), '死神永生')

  // 关掉留存：形状识别照跑（成没成要留在读数里），但写缓存一律跳过
  const before = mem.size
  const withheld = newSubject()
  withheld.content_withheld = true
  observeCall('demo', { bookId: 'b9' }, { bookId: 'b9', name: '不该进缓存', bookTypeCode: 0 }, withheld, { nameCache: cache, withheld: true })
  assert.equal(mem.size, before, 'withheld 时不许写命名缓存')
  assert.equal(withheld.book_name, '不该进缓存', '抽取本身照跑（写明细时再由 withholdContent 抹）')

  // 章标识里带着书标识（URL 形态）：正文只带 itemId 时也要能把书认出来
  const url = newSubject()
  observeCall('demo', { itemId: 'https://x/c?bookId=b7&itemId=c7' }, { contentType: 'novel', data: { content: 'x' } }, url, { nameCache: cache })
  assert.equal(url.book_key, 'b7', '从章标识里拆出书标识（Go 的 BookIdentFromChapterKey 同口径）')
})
