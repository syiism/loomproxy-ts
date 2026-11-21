#!/usr/bin/env node
// 改插件代码后必须 bump manifest.version：版本是开发者声明位，外部多版本管理靠它。
// 用法：node tools/bump-plugin-version.mjs fq_drama fq_manju [minor|major]
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const part = args.includes('minor') ? 'minor' : args.includes('major') ? 'major' : 'patch'
const codes = args.filter((a) => !['minor', 'major'].includes(a))
if (codes.length === 0) {
  console.error('用法: node tools/bump-plugin-version.mjs <code> [code...] [minor|major]')
  process.exit(2)
}
const root = new URL('..', import.meta.url).pathname
for (const code of codes) {
  const file = join(root, 'plugins', code, 'manifest.json')
  const m = JSON.parse(readFileSync(file, 'utf8'))
  const [a, b, c] = String(m.version ?? '0.0.0').split('.').map(Number)
  const next =
    part === 'major' ? `${a + 1}.0.0` :
    part === 'minor' ? `${a}.${b + 1}.0` :
    `${a}.${b}.${c + 1}`
  m.version = next
  writeFileSync(file, JSON.stringify(m, null, 2) + '\n')
  console.log(`${code}: ${[a, b, c].join('.')} -> ${next}`)
}
