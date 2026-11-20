#!/usr/bin/env node
// 方案 B 工具：源码包即插件（plugins/<code>/<version>/ 直接开发/运行/部署）。
// 每个源码包迁入后做两件事：
//   ① 版本目录内 src/**.ts 的 @loomproxy/{contract,source-kit} import 改写为 code 级 deps/ 相对路径
//      ——不能留裸包名（Node 只认 node_modules 目录，而 strip-types 拒绝 node_modules 下的 .ts）
//   ② plugins/<code>/deps/ 填 contract + source-kit + zod（多版本共享，纯 TS/JS 文本，几 MB）
// 用法：node tools/sync-plugins.mjs <code> [更多 code...]   # 源码包当前在 packages/sources/<code>
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const codes = process.argv.slice(2)
if (codes.length === 0) {
  console.error('用法: node tools/sync-plugins.mjs <code> [code...]')
  process.exit(2)
}

function collectTs(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) collectTs(p, base, acc)
    else if (e.name.endsWith('.ts')) acc.push(relative(base, p).split('\\').join('/'))
  }
  return acc
}

/** 把 fromFile 里的 @loomproxy/* 改写成 code 级 deps/ 相对路径 */
function depsize(tsSource, fromFile, codeDir) {
  const map = { '@loomproxy/contract': 'deps/contract/src/index.ts', '@loomproxy/source-kit': 'deps/source-kit/src/index.ts' }
  let out = tsSource
  const fromDir = dirname(fromFile) // relative 的 from 必须是目录（带文件名会多退一层）
  for (const [spec, file] of Object.entries(map)) {
    let rel = relative(fromDir, join(codeDir, file)).split('\\').join('/')
    if (!rel.startsWith('.')) rel = './' + rel
    out = out.split(`from '${spec}'`).join(`from '${rel}'`)
    out = out.split(`from "${spec}"`).join(`from "${rel}"`)
    out = out.split(`import('${spec}')`).join(`import('${rel}')`)
  }
  return out
}

/** deps 里内部相对 import 不动；deps/source-kit 对 contract 的引用改到 deps/contract */
function fixDepsInternal(dir) {
  for (const rel of collectTs(dir)) {
    const p = join(dir, rel)
    const ts = readFileSync(p, 'utf8')
    let out = ts
    // source-kit → contract：同在 deps 下，按相对层级算
    if (/@loomproxy\/contract/.test(out)) {
      let rel0 = relative(join(dir, rel, '..'), join(dir, 'contract/src/index.ts')).split('\\').join('/')
      if (!rel0.startsWith('.')) rel0 = './' + rel0
      out = out.split(`from '@loomproxy/contract'`).join(`from '${rel0}'`)
      out = out.split(`from "@loomproxy/contract"`).join(`from "${rel0}"`)
    }
    if (out !== ts) writeFileSync(p, out)
  }
}

for (const code of codes) {
  const srcPkg = join(root, 'packages', 'sources', code)
  const manifestPath = join(srcPkg, 'manifest.json')
  if (!existsSync(manifestPath)) {
    console.error(`不是源码包: ${srcPkg}`)
    process.exit(2)
  }
  const pkg = JSON.parse(readFileSync(join(srcPkg, 'package.json'), 'utf8'))
  const version = String(pkg.version ?? '0.0.0')
  const codeDir = join(root, 'plugins', code)
  const target = join(codeDir, version)

  // ① 版本目录：manifest + index.mjs + src(改写) + test
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'manifest.json'), readFileSync(manifestPath))
  writeFileSync(join(target, 'index.mjs'), `export { default } from './src/index.ts'\n`)
  for (const rel of collectTs(join(srcPkg, 'src'))) {
    const dest = join(target, 'src', rel)
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, depsize(readFileSync(join(srcPkg, 'src', rel), 'utf8'), join(target, 'src', rel), codeDir))
  }
  if (existsSync(join(srcPkg, 'test'))) cpSync(join(srcPkg, 'test'), join(target, 'test'), { recursive: true })

  // ② code 级 deps（多版本共享；已存在则跳过填充，只修内部引用）
  const depsDir = join(codeDir, 'deps')
  if (!existsSync(join(depsDir, 'contract'))) {
    rmSync(depsDir, { recursive: true, force: true })
    mkdirSync(depsDir, { recursive: true })
    cpSync(join(root, 'packages', 'contract'), join(depsDir, 'contract'), { recursive: true })
    cpSync(join(root, 'packages', 'source-kit'), join(depsDir, 'source-kit'), { recursive: true })
    for (const d of ['contract', 'source-kit']) {
      rmSync(join(depsDir, d, 'node_modules'), { recursive: true, force: true })
      rmSync(join(depsDir, d, 'test'), { recursive: true, force: true })
    }
    // zod：contract 依赖它；deps/zod 保持包结构（package.json name=zod），由 deps 内 node_modules 解析
    mkdirSync(join(depsDir, 'node_modules'), { recursive: true })
    cpSync(join(root, 'node_modules', 'zod'), join(depsDir, 'node_modules', 'zod'), { recursive: true, dereference: true })
    // deps 内部相对引用修正
    fixDepsInternal(depsDir)
  }
  console.log(`已同步 ${code}@${version} → ${target}（deps 共享于 ${depsDir}）`)
}
