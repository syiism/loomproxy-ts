#!/usr/bin/env node
// 把源码包打包成**自包含**的运行期插件目录：
//   plugins/<code>/<version>/ = manifest.json + index.mjs + src/** + vendor/{contract,source-kit}/**.ts
// 自包含的含义：产物离开仓库树/离开 workspace 也能被 Node 24 直接加载——
//   · src/index.ts 与 vendor 内部全部用产物内相对路径互相引用；
//   · 唯一保留的外部依赖是 zod（宿主 node_modules 必有，这是宿主契约，见 docs/方案/源插件编写范式.md）。
//   node tools/pack-plugin.mjs <code> [--out plugins]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

const args = process.argv.slice(2)
const code = args.find((a) => !a.startsWith('--'))
const outIdx = args.indexOf('--out')
const out = outIdx >= 0 ? args[outIdx + 1] : 'plugins'
if (!code) {
  console.error('用法: node tools/pack-plugin.mjs <code> [--out plugins]')
  process.exit(2)
}

const root = new URL('..', import.meta.url).pathname
const pkgDir = join(root, 'packages', 'sources', code)
const pkgPath = join(pkgDir, 'package.json')
const manifestPath = join(pkgDir, 'manifest.json')
const srcDir = join(pkgDir, 'src')
if (!existsSync(pkgPath) || !existsSync(manifestPath) || !existsSync(srcDir)) {
  console.error(`不是插件源码包: ${pkgDir}（要 package.json + manifest.json + src/）`)
  process.exit(2)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const version = String(pkg.version ?? '0.0.0')
const target = resolve(root, out, code, version)

/** 递归收集 .ts 文件（保留相对路径） */
function collectTs(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) collectTs(p, base, acc)
    else if (e.name.endsWith('.ts')) acc.push(relative(base, p).split('\\').join('/'))
  }
  return acc
}

/** 相对 specifier：fromFile（产物内文件）→ toPath（产物内目标），保证 ./ 或 ../ 开头 */
function relSpec(fromFile, toPath) {
  let rel = relative(join(target, fromFile, '..'), join(target, toPath)).split('\\').join('/')
  if (!rel.startsWith('.')) rel = './' + rel
  return rel
}

/**
 * 重写一个 TS 文件里的 workspace import：@loomproxy/contract → vendor 内相对路径。
 * 只动 `from '@loomproxy/xxx'` 与 `import('@loomproxy/xxx')` 两种形状（类型导入同样受益）。
 */
function vendorize(tsSource, fromFile) {
  const map = { '@loomproxy/contract': 'vendor/contract/index.ts', '@loomproxy/source-kit': 'vendor/source-kit/index.ts' }
  let out = tsSource
  for (const [spec, file] of Object.entries(map)) {
    const target = relSpec(fromFile, file)
    out = out.split(`from '${spec}'`).join(`from '${target}'`)
    out = out.split(`from "${spec}"`).join(`from "${target}"`)
    out = out.split(`import('${spec}')`).join(`import('${target}')`)
  }
  return out
}

mkdirSync(join(target, '..'), { recursive: true })
const staging = join(target, '..', `.${code}-staging-${Math.random().toString(36).slice(2, 8)}`)
mkdirSync(staging, { recursive: true })
try {
  // manifest 原样拷（运行期声明位的唯一来源）
  writeFileSync(join(staging, 'manifest.json'), readFileSync(manifestPath))
  // src/** 与 vendor/**：全部 vendorize 后落盘（产物内相对引用，脱离 workspace 可解析）
  const groups = [
    { from: srcDir, to: 'src', base: srcDir },
    { from: join(root, 'packages', 'contract', 'src'), to: 'vendor/contract', base: join(root, 'packages', 'contract', 'src') },
    { from: join(root, 'packages', 'source-kit', 'src'), to: 'vendor/source-kit', base: join(root, 'packages', 'source-kit', 'src') },
  ]
  for (const g of groups) {
    for (const rel of collectTs(g.from)) {
      const destFile = join(staging, g.to, rel)
      mkdirSync(join(destFile, '..'), { recursive: true })
      const ts = readFileSync(join(g.from, rel), 'utf8')
      writeFileSync(destFile, vendorize(ts, join(g.to, rel)))
    }
  }
  // 入口：产物内相对引用
  writeFileSync(join(staging, 'index.mjs'), `export { default } from './src/index.ts'\n`)
  // vendor 里的 contract 依赖 zod：产物自带一份（解引用软链后拷真实目录），
  // 这样产物在无 workspace 的机器上也能解析（宿主契约只剩 node 本身）。
  const zodReal = resolve(root, 'node_modules/zod')
  const zodDest = join(staging, 'node_modules', 'zod')
  mkdirSync(zodDest, { recursive: true })
  cpSync(zodReal, zodDest, { recursive: true, dereference: true })
  if (existsSync(target)) rmSync(target, { recursive: true })
  renameSync(staging, target) // 同目录 rename 原子生效（半成品不被 host 扫到）
  console.log(`已打包 ${code}@${version} → ${target}（自包含：manifest + index.mjs + src/ + vendor/）`)
} catch (e) {
  rmSync(staging, { recursive: true, force: true })
  throw e
}
