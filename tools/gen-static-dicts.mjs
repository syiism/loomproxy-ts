#!/usr/bin/env node
// 从 tools/data/static/ 的字典正本生成插件内的 TS 只读表，避免"库里一份、插件里一份"漂移。
// --check 只比对不写文件，给 pnpm run check 用。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const check = process.argv.includes('--check')
const read = (p) => JSON.parse(readFileSync(join(root, 'tools/data/static', p), 'utf8'))

const ranks = read('qm/qm_ranks.json')
const tags = read('qm/qm_tags.json')
const columns = [...(ranks.ranks ?? []), ...(ranks.categories ?? []), ...(tags.tags ?? [])]
const lines = [
  '// 由 tools/gen-static-dicts.mjs 从 tools/data/static/qm/*.json 生成，勿手改。',
  'export type Column = { kind: "rank" | "category" | "tag"; name: string; id: string; tab?: string }',
  'export const COLUMNS: Column[] = [',
  ...columns.map((c) => `  { kind: ${JSON.stringify(c.kind)}, name: ${JSON.stringify(c.name)}, id: ${JSON.stringify(c.id)}${c.tab ? `, tab: ${JSON.stringify(c.tab)}` : ''} },`),
  ']',
  '',
]
const target = join(root, 'plugins/qm_novel/src/columns.generated.ts')
const content = lines.join('\n')
if (check) {
  // 插件目录不入库；新 clone 里生成物不存在时按正本生成，保证 check 可独立跑通
  if (!existsSync(target)) {
    writeFileSync(target, content)
    console.log(`静态字典生成物缺失，已生成（${columns.length} 项）`)
    process.exit(0)
  }
  const current = readFileSync(target, 'utf8')
  if (current !== content) {
    console.error('✗ 静态字典生成物已漂移：运行 node tools/gen-static-dicts.mjs')
    process.exit(1)
  }
  console.log(`静态字典对拍通过（${columns.length} 项）`)
} else {
  writeFileSync(target, content)
  console.log(`已生成 plugins/qm_novel/src/columns.generated.ts（${columns.length} 项）`)
}
