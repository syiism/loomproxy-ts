#!/usr/bin/env node
// 漏斗依赖检查（迁移-TS-3 §3/§7）：依赖只许向下，plugins 只认 SDK，树里不许出现 Go 代码。
// 用文本扫描而不是引第三方工具：规则要能被下一个改代码的人一眼读懂。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const PKG = 'packages'
const APP = 'apps'

// 层号越小越靠下；只许 import 层号更小的
const LAYER = {
  contract: 0,
  kernel: 1,
  store: 2,
  'source-kit': 2,
  gate: 3,
  'source-host': 3,
  api: 4,
  plugins: 4,
  server: 5,
}

const ALLOW = {
  contract: [],
  kernel: ['contract'],
  store: ['contract', 'kernel'],
  'source-kit': ['contract', 'kernel'],
  gate: ['contract', 'kernel', 'store'],
  'source-host': ['contract', 'kernel', 'store', 'source-kit'],
  api: ['contract', 'kernel', 'store', 'source-kit', 'gate', 'source-host'],
  // 插件（源包）只认 SDK：不许 import store/gate/api/server，也不许互相 import（同族共享包例外，后续登记）
  plugins: ['contract', 'kernel', 'source-kit'],
  server: ['contract', 'kernel', 'store', 'source-kit', 'gate', 'source-host', 'api'],
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'test' || e.name === 'fixtures') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|mjs|js)$/.test(e.name) && !e.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

function pkgOf(file) {
  const rel = relative(ROOT, file)
  const parts = rel.split('/')
  if (parts[0] === PKG && parts[1] === 'plugins') return 'plugins'
  if (parts[0] === PKG) return parts[1]
  if (parts[0] === APP) return 'server'
  return undefined
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g

let errors = 0
const report = (msg) => {
  errors++
  console.error(`✗ ${msg}`)
}

// 规则 0：树里不许有 Go 代码（本分支的实现只允许 TS/JS）
const goFiles = []
function findGo(dir) {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) findGo(p)
    else if (e.name.endsWith('.go')) goFiles.push(relative(ROOT, p))
  }
}
findGo(ROOT)
for (const f of goFiles) report(`树里出现 Go 代码：${f}`)

// 规则 1：包间只许向下
for (const top of [PKG, APP]) {
  const topDir = join(ROOT, top)
  if (!existsSync(topDir)) continue
  for (const entry of readdirSync(topDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const ours = top === APP ? 'server' : entry.name === 'plugins' ? 'plugins' : entry.name
    const allow = ALLOW[ours]
    if (!allow) {
      report(`未在分层表里登记的包：${top}/${entry.name}（先登记层级再写代码）`)
      continue
    }
    for (const file of walk(join(topDir, entry.name))) {
      const src = readFileSync(file, 'utf8')
      let m
      IMPORT_RE.lastIndex = 0
      while ((m = IMPORT_RE.exec(src)) !== null) {
        const spec = m[1]
        if (!spec) continue
        const rel = relative(ROOT, file)
        if (spec.startsWith('.')) {
          // 相对导入不许跨包
          const target = pkgOf(join(file, '..', spec))
          if (target && target !== ours) {
            report(`${rel} 用相对路径跨包 import：${spec}`)
          }
          continue
        }
        const nm = /^@loomproxy\/(.+)$/.exec(spec)
        if (!nm) continue
        const dep = nm[1]
        if (dep === ours) continue
        if (!allow.includes(dep)) {
          report(`${rel} 违反漏斗：${ours}(L${LAYER[ours]}) 依赖了 ${dep}(L${LAYER[dep]})`)
        }
      }
    }
  }
}

// 规则 2：packages/* 不许 import apps/*
for (const top of [PKG]) {
  const topDir = join(ROOT, top)
  if (!existsSync(topDir)) continue
  for (const entry of readdirSync(topDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const file of walk(join(topDir, entry.name))) {
      const src = readFileSync(file, 'utf8')
      if (/@loomproxy\/server|\.\.\/\.\.\/apps\//.test(src)) {
        report(`${relative(ROOT, file)} 从 packages 反向依赖了 apps/*`)
      }
    }
  }
}

if (errors > 0) {
  console.error(`\n分层检查失败：${errors} 处`)
  process.exit(1)
}
console.log('分层检查通过（依赖只许向下、plugins 只认 SDK、无 Go 代码）')
