import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceRegistry } from '../src/registry.ts'
import { defineSource } from '../src/handler.ts'
import { stampSearchSource } from '../src/present.ts'
import { observeCall } from '../src/observe.ts'
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
