#!/usr/bin/env node
// 方案 B 的依赖同步（源码即插件）：plugins/<code>/<version>/ 是可直接跑/拷走的源码，
// 每个 code 的 deps/ 是它自己的依赖（多版本共享）。
//
// 两条硬规则，违反就跑不起来：
//   ① 绝不建软链——相对软链拷出仓库就断，绝对软链离开本机就断。第三方纯 JS 包以真实文件放在
//      <code>/node_modules/（标准 ESM 解析链：<version>/ → <code>/）；Node 的 strip-types 拒绝加载
//      node_modules 下的 .ts，所以 SDK 源码另放 deps/contract 与 deps/source-kit，用相对路径 import。
//   ② 版本目录的 src/test 里不许留裸 @loomproxy/* import——独立目录没有 workspace 解析链。
//
// 用法：node tools/sync-plugin-deps.mjs [code ...]   # 省参数则同步全部插件
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pluginsDir = join(root, 'plugins')
const allCodes = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^[a-z0-9_]+$/.test(e.name))
  .map((e) => e.name)
  .sort()
const codes = process.argv.slice(2)
if (codes.some((c) => !allCodes.includes(c))) {
  console.error(`未知插件：${codes.filter((c) => !allCodes.includes(c)).join(', ')}；可选：${allCodes.join(', ')}`)
  process.exit(2)
}
const targets = codes.length > 0 ? codes : allCodes

const SDK = {
  '@loomproxy/contract': 'deps/contract/src/index.ts',
  '@loomproxy/source-kit': 'deps/source-kit/src/index.ts',
}
const IMPORT_RE = /(from\s+|import\s*\(\s*|require\s*\(\s*)(['"])([^'"]+)\2/g

/** 把 @loomproxy/* 改成 fromFile 到 code 级 deps 的相对路径 */
function rewriteSdkImports(source, fromFile, codeDir) {
  return source.replace(IMPORT_RE, (whole, prefix, quote, spec) => {
    const dest = SDK[spec]
    if (!dest) return whole
    let rel = relative(dirname(fromFile), join(codeDir, dest)).split('\\').join('/')
    if (!rel.startsWith('.')) rel = './' + rel
    return `${prefix}${quote}${rel}${quote}`
  })
}

function collectFiles(dir, base = dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'test') collectFiles(p, base, acc)
    } else if (/\.(ts|mjs|js)$/.test(e.name)) acc.push(relative(base, p))
  }
  return acc
}

function versionsOf(codeDir) {
  return readdirSync(codeDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d+\.\d+/.test(e.name))
    .map((e) => e.name)
}

/** SDK 源码副本：去掉包自己的 node_modules/test，再修它内部的跨包引用 */
function materializeSdk(codeDir) {
  const depsDir = join(codeDir, 'deps')
  rmSync(join(depsDir, 'contract'), { recursive: true, force: true })
  rmSync(join(depsDir, 'source-kit'), { recursive: true, force: true })
  for (const name of ['contract', 'source-kit']) {
    const dest = join(depsDir, name)
    cpSync(join(root, 'packages', name), dest, {
      recursive: true,
      dereference: true,
      filter: (src) => !/[\\/](node_modules|test)([\\/]|$)/.test(src),
    })
    for (const rel of collectFiles(dest)) {
      const file = join(dest, rel)
      const out = rewriteSdkImports(readFileSync(file, 'utf8'), file, codeDir)
      if (out !== readFileSync(file, 'utf8')) writeFileSync(file, out)
    }
  }
}

/** 解析包真实目录（pnpm 下 node_modules/<name> 是软链，必须 realpath 后拷贝） */
function resolvePackage(name, fromDir) {
  const req = createRequire(join(fromDir, '__resolve__.cjs'))
  let entry
  try {
    entry = req.resolve(`${name}/package.json`)
  } catch {
    // 多数包不在 exports 里暴露 package.json，改从主入口向上找包根
    try {
      entry = req.resolve(name)
    } catch {
      return undefined
    }
  }
  let dir = dirname(realpathSync(entry))
  // dist/ 子目录里常有 {"type":"commonjs"} 的局部 package.json，必须找到带 name 的包根
  while (dir !== dirname(dir)) {
    const pj = join(dir, 'package.json')
    if (existsSync(pj)) {
      const json = JSON.parse(readFileSync(pj, 'utf8'))
      if (json.name === name) return { dir, json }
    }
    dir = dirname(dir)
  }
  return undefined
}

/**
 * 把 JS 依赖闭包以真实文件放进 <code>/node_modules。
 * pnpm 的 sibling 软链在这里全部解引用；同包多版本按 Node 解析规则放到依赖方自己的
 * node_modules（entities@4 与 @7 并存就是这么处理的），不能粗暴扁平化。
 */
function vendorJsDeps(codeDir, bareImports) {
  const placements = new Map() // node_modules 目录 → Map(包名 → 版本)
  const versions = new Map()
  const visibleVersion = (nmDir, name) => {
    for (let dir = nmDir; dir.startsWith(codeDir); dir = dirname(dir)) {
      const v = placements.get(dir)?.get(name)
      if (v !== undefined) return v
    }
    return undefined
  }
  const topNm = join(codeDir, 'node_modules')
  rmSync(topNm, { recursive: true, force: true })
  mkdirSync(topNm, { recursive: true })
  const queue = ['zod', ...bareImports].map((name) => ({ name, from: root, nmDir: topNm }))
  while (queue.length > 0) {
    const { name, from, nmDir } = queue.shift()
    if (builtinModules.includes(name) || name.startsWith('node:')) continue
    const pkg = resolvePackage(name, from)
    if (!pkg) throw new Error(`依赖 ${name} 解析不到（从 ${from}）；先 pnpm install`)
    const version = pkg.json.version ?? 'unknown'
    if (visibleVersion(nmDir, name) === version) continue
    const dest = join(nmDir, ...name.split('/'))
    rmSync(dest, { recursive: true, force: true })
    cpSync(pkg.dir, dest, { recursive: true, dereference: true })
    const placed = placements.get(nmDir) ?? new Map()
    placed.set(name, version)
    placements.set(nmDir, placed)
    versions.set(name, version)
    for (const dep of Object.keys(pkg.json.dependencies ?? {})) {
      const depPkg = resolvePackage(dep, pkg.dir)
      if (!depPkg) throw new Error(`${name} 的依赖 ${dep} 解析不到；先 pnpm install`)
      // 依赖方看到的上层版本若不符，就落在它自己的 node_modules 里
      const visible = visibleVersion(nmDir, dep)
      const depNm = visible !== undefined && visible !== (depPkg.json.version ?? 'unknown') ? join(dest, 'node_modules') : nmDir
      queue.push({ name: dep, from: pkg.dir, nmDir: depNm })
    }
  }
  return versions
}

for (const code of targets) {
  const codeDir = join(pluginsDir, code)
  const vers = versionsOf(codeDir)
  if (vers.length === 0) throw new Error(`${code} 下没有版本目录 <code>/<version>/`)
  const link = join(pluginsDir, 'node_modules')
  if (existsSync(link) && lstatSync(link).isSymbolicLink()) {
    throw new Error(`发现 ${link} 软链：插件依赖必须落在各自 deps/，不能靠仓库 node_modules 兜底`)
  }

  materializeSdk(codeDir)

  // 版本目录：入口与源码保持原样，只把裸 SDK import 改成相对 deps 路径；测试同理
  const rewritten = new Set()
  for (const version of vers) {
    const verDir = join(codeDir, version)
    for (const rel of [...collectFiles(verDir), ...collectFiles(join(verDir, 'test')).map((r) => join('test', r))]) {
      const file = join(verDir, rel)
      if (!existsSync(file)) continue
      const before = readFileSync(file, 'utf8')
      const after = rewriteSdkImports(before, file, codeDir)
      if (after !== before) {
        writeFileSync(file, after)
        rewritten.add(rel)
      }
    }
  }

  // 依赖闭包由版本目录（含测试）里真实的裸包名决定，而不是手抄一份
  const bare = new Set()
  for (const version of vers) {
    const verDir = join(codeDir, version)
    for (const rel of [...collectFiles(verDir), ...collectFiles(join(verDir, 'test')).map((r) => join('test', r))]) {
      const file = join(verDir, rel)
      if (!existsSync(file)) continue
      IMPORT_RE.lastIndex = 0
      for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
        const spec = m[3]
        if (spec && !spec.startsWith('.') && !spec.startsWith('node:') && !spec.startsWith('@loomproxy/')) bare.add(spec.split('/')[0])
      }
    }
  }
  const versions = vendorJsDeps(codeDir, [...bare])
  console.log(`已同步 ${code}：版本 ${vers.join(', ')}；JS 依赖 ${[...versions].map(([n, v]) => `${n}@${v}`).join(' ')}；改写 import ${rewritten.size} 个文件`)
}
