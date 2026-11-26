#!/usr/bin/env node
// 从 tools/data/static/ 的字典正本生成插件内的 TS 只读表，避免"库里一份、插件里一份"漂移。
// --check 只比对不写文件，给 pnpm run check 用；新 clone 缺生成物时按正本补生成。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const check = process.argv.includes('--check')
const read = (p) => JSON.parse(readFileSync(join(root, 'tools/data/static', p), 'utf8'))
const outputs = []

// 七猫：ranks + categories + tags → qm_novel/src/columns.generated.ts
{
  const ranks = read('qm_novel/qm_ranks.json')
  const tags = read('qm_novel/qm_tags.json')
  const columns = [...(ranks.ranks ?? []), ...(ranks.categories ?? []), ...(tags.tags ?? [])]
  const content = [
    '// 由 tools/gen-static-dicts.mjs 从 tools/data/static/qm_novel/*.json 生成，勿手改。',
    'export type Column = { kind: "rank" | "category" | "tag"; name: string; id: string; tab?: string }',
    'export const COLUMNS: Column[] = [',
    ...columns.map((c) => `  { kind: ${JSON.stringify(c.kind)}, name: ${JSON.stringify(c.name)}, id: ${JSON.stringify(c.id)}${c.tab ? `, tab: ${JSON.stringify(c.tab)}` : ''} },`),
    ']',
    '',
  ].join('\n')
  outputs.push(['plugins/qm_novel/src/columns.generated.ts', content, columns.length])
}

// 番茄五形态：data/<source>/categories.json → src/categories.generated.ts
for (const code of ['fq_novel', 'fq_comic', 'fq_drama', 'fq_manju']) {
  const data = read(`${code}/categories.json`)
  const lines = [
    '// 由 tools/gen-static-dicts.mjs 生成，正本在 tools/data/static/<source>/categories.json，勿手改。',
    'export type FqCategoryTab = { tab: string; name: string; gender: number; genreType: number }',
    `export const FQ_CATEGORY_TABS: FqCategoryTab[] = ${JSON.stringify(data.tabs ?? [], null, 2)}`,
    '',
    'export type FqCategory = { id: string; name: string }',
    `export const FQ_CATEGORIES: FqCategory[] = ${JSON.stringify(data.categories ?? [], null, 2)}`,
    '',
    "export const NC_GROUP_PARAM: Readonly<Record<string, string>> = { 男频: 'gender=1', 女频: 'gender=0', 出版: 'genre_type=160' }",
    'export const COMIC_CATEGORIES: ReadonlyArray<readonly [string, number]> = FQ_CATEGORIES.map((c) => [c.name, Number(c.id)] as const)',
    '',
  ]
  outputs.push([`plugins/${code}/src/categories.generated.ts`, lines.join('\n'), data.categories.length])
}
{
  const data = read('fq_audio/categories.json')
  const content = [
    '// 由 tools/gen-static-dicts.mjs 生成，正本在 tools/data/static/fq_audio/categories.json，勿手改。',
    'export type TtsCategory = { tag: string; parent: string; id: string; name: string }',
    `export const TTS_CATEGORIES: TtsCategory[] = ${JSON.stringify(data.categories ?? [], null, 2)}`,
    '',
  ].join('\n')
  outputs.push(['plugins/fq_audio/src/categories.generated.ts', content, data.categories.length])
}

let bad = 0
for (const [rel, content, count] of outputs) {
  const target = join(root, rel)
  if (check && existsSync(target) && readFileSync(target, 'utf8') !== content) {
    console.error(`✗ 静态字典生成物已漂移：${rel}（运行 pnpm run gen:dicts）`)
    bad++
    continue
  }
  if (!check || !existsSync(target)) writeFileSync(target, content)
}
if (check) {
  if (bad) process.exit(1)
  console.log(`静态字典对拍通过（${outputs.length} 份，${outputs.reduce((n, o) => n + o[2], 0)} 项）`)
} else {
  console.log(`已生成 ${outputs.length} 份静态字典生成物`)
}
