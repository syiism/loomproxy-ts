import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mediaFromBookTypeCode,
  mediaFromContentType,
  mediaLabel,
  parseSourceMeta,
  pluginManifestSchema,
  keywordOf,
  withholdContent,
  newSubject,
} from '../src/index.ts'

test('声明位：合法 manifest 过得去，非法形态在注册期就失败', () => {
  const meta = parseSourceMeta({
    code: 'demo_one',
    display: '演示',
    category: 'demo',
    actions: ['search'],
  })
  assert.equal(meta.status, 1)
  assert.equal(meta.fixed_base_url, false)

  // 未声明的动作不许出现在 required_params
  assert.throws(
    () =>
      parseSourceMeta({
        code: 'demo_two',
        display: '演示',
        category: 'demo',
        actions: ['search'],
        required_params: { content: ['itemId'] },
      }),
    /未声明的动作/,
  )
  // 平台保留前缀
  assert.throws(
    () =>
      parseSourceMeta({
        code: 'demo_three',
        display: '演示',
        category: 'demo',
        actions: ['content'],
        required_params: { content: ['_datafile_parts'] },
      }),
    /保留前缀/,
  )
  // 未知键要报错（strict）：防"写错字段名而静默失效"
  assert.throws(() =>
    parseSourceMeta({ code: 'demo_four', display: 'd', category: 'c', actions: ['search'], mediaTypes: 'novel' }),
  )
})

test('plugin manifest：sdk_version / isolation / entry 必填，默认 in-process', () => {
  const m = pluginManifestSchema.parse({
    sdk_version: '^1',
    entry: './index.mjs',
    meta: { code: 'demo', display: 'd', category: 'c', actions: ['search'] },
  })
  assert.equal(m.isolation, 'in-process')
  assert.throws(() =>
    pluginManifestSchema.parse({
      sdk_version: '1',
      entry: './x.mjs',
      isolation: 'process',
      meta: { code: 'demo', display: 'd', category: 'c', actions: ['search'] },
    }),
  )
})

test('媒介判定：bookTypeCode 缺失 ≠ 0；contentType 归一两种写法', () => {
  assert.equal(mediaFromBookTypeCode(0), 'novel')
  assert.equal(mediaFromBookTypeCode(1), 'comic')
  assert.equal(mediaFromBookTypeCode(2), 'audio')
  assert.equal(mediaFromBookTypeCode(3), 'video')
  assert.equal(mediaFromBookTypeCode(99), '')
  assert.equal(mediaFromContentType('TEXT'), 'novel')
  assert.equal(mediaFromContentType('manga'), 'comic')
  assert.equal(mediaFromContentType('error'), '')
  assert.equal(mediaLabel(''), '未判定')
})

test('DTO 空值语义：omitempty 字段在 JSON 里必须消失，而不是变成 null', () => {
  const item = {
    bookId: '1',
    name: 'n',
    author: 'a',
    kind: 'demo',
    wordCount: '',
    lastChapter: '',
    intro: '',
    coverUrl: '',
    bookTypeCode: undefined,
    source: undefined,
  }
  const json = JSON.stringify(item)
  assert.ok(!json.includes('bookTypeCode'))
  assert.ok(!json.includes('null'))
})

test('搜索词别名与内容留存抹除', () => {
  assert.equal(keywordOf({ query: '三体' }), '三体')
  assert.equal(keywordOf({ wd: 'x', key: 'y' }), 'y')
  const s = newSubject()
  s.keyword = 'k'
  s.book_key = 'b'
  s.chapter_key = 'c'
  s.in_band_error = true
  const w = withholdContent(s)
  assert.equal(w.keyword, '')
  assert.equal(w.book_key, '')
  assert.equal(w.content_withheld, true)
  assert.equal(w.in_band_error, true, '带内失败说的是这次成没成，不该被留存开关抹掉')
})
