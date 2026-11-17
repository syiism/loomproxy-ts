#!/usr/bin/env node
// 把 packages/plugins/<code> 打包成一个可在运行期加载的版本目录：
//   plugins/<code>/<version>/{manifest.json, index.mjs}
// index.mjs 用绝对 file URL re-export TS 源码（Node 24 直接跑 .ts），
// 所以"开发形态=运行形态"，不需要 bundler。
//   node tools/pack-plugin.mjs <code> [--out plugins]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const code = args.find((a) => !a.startsWith('--'))
const outIdx = args.indexOf('--out')
const out = outIdx >= 0 ? args[outIdx + 1] : 'plugins'
if (!code) {
  console.error('用法: node tools/pack-plugin.mjs <code> [--out plugins]')
  process.exit(2)
}

const root = new URL('..', import.meta.url).pathname
const pkgDir = join(root, 'packages', 'plugins', code)
const pkgPath = join(pkgDir, 'package.json')
const manifestPath = join(pkgDir, 'manifest.json')
if (!existsSync(pkgPath) || !existsSync(manifestPath)) {
  console.error(`不是插件包: ${pkgDir}（要 package.json + manifest.json）`)
  process.exit(2)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const version = String(pkg.version ?? '0.0.0')
const target = resolve(root, out, code, version)
mkdirSync(target, { recursive: true })

// manifest 原样拷（它是运行期声明位的唯一来源）
writeFileSync(join(target, 'manifest.json'), readFileSync(manifestPath))
// 入口指到插件包的 TS 源码（绝对 file URL，避免相对层级算错）
const entry = pathToFileURL(join(pkgDir, 'src', 'index.ts')).href
writeFileSync(join(target, 'index.mjs'), `export { default } from '${entry}'\n`)
console.log(`已打包 ${code}@${version} → ${target}`)
