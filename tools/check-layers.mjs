#!/usr/bin/env node
// 漏斗依赖检查（迁移-TS-3 §3/§7）：依赖只许向下，plugins 只认 SDK，树里不许出现 Go 代码。
// 用文本扫描而不是引第三方工具：规则要能被下一个改代码的人一眼读懂。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const PKG = 'packages'
const APP = 'apps'

// 层号越小越靠下；只许 import 层号更小的
const LAYER = {
  contract: 0,
  kernel: 1,
  store: 2,
  'source-kit': 2,
  pool: 2,
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
  // 池运行时：只认契约（DeviceStore 端口声明在 contract）与 kernel
  pool: ['contract', 'kernel'],
  gate: ['contract', 'kernel', 'store'],
  'source-host': ['contract', 'kernel', 'store', 'source-kit'],
  api: ['contract', 'kernel', 'store', 'source-kit', 'gate', 'source-host', 'pool'],
  // 插件（源包）只认 SDK：不许 import store/gate/api/server，也不许互相 import
  plugins: ['contract', 'kernel', 'source-kit'],
  server: ['contract', 'kernel', 'store', 'source-kit', 'gate', 'source-host', 'pool', 'api'],
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
    const ours = top === APP ? 'server' : entry.name === 'plugins' ? 'plugins' : entry.name === 'sources' ? 'sources' : entry.name
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

// 规则 1b：SDK 2 插件 = plugins/<code>/ 单版本目录（源码即插件）。
// 不允许软链/版本目录/deps（拷走就断、服务只认当前一份）；运行时不许从 @loomproxy/* 导入值——
// SDK 由宿主在工厂调用时注入，插件源码只能 `import type`（Node strip-types 会把类型导入擦掉）。
const PLUGINS = join(ROOT, 'plugins')
if (existsSync(PLUGINS)) {
  for (const code of readdirSync(PLUGINS, { withFileTypes: true })) {
    if (code.isSymbolicLink()) {
      report(`plugins/${code.name} 是软链（插件依赖只能是真实文件）`)
      continue
    }
    if (!code.isDirectory() || !/^[a-z0-9_]+$/.test(code.name)) continue
    const codeDir = join(PLUGINS, code.name)
    const files = []
    const walkPlugin = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) {
          report(`plugins/${code.name} 里出现软链 ${relative(ROOT, join(dir, e.name))}（插件依赖只能是真实文件）`)
          continue
        }
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (['node_modules', 'deps', '.git'].includes(e.name) || /^\d+\.\d+/.test(e.name)) {
            report(`plugins/${code.name}/${e.name}：SDK 2 插件只有单版本目录，不许有 deps/、node_modules/ 或 <version>/`)
            continue
          }
          walkPlugin(p)
        } else if (/\.(ts|mjs|js)$/.test(e.name)) files.push(p)
      }
    }
    walkPlugin(codeDir)
    for (const file of files) {
      const rel = relative(ROOT, file)
      if (file.includes(`${'node_modules'}/`)) {
        if (file.endsWith('.ts') && !file.endsWith('.d.ts')) report(`${rel}：node_modules 下不许有 .ts（Node strip-types 会拒绝加载）`)
        continue
      }
      const src = readFileSync(file, 'utf8')
      const inSrc = /^plugins\/[^/]+\/src\//.test(rel)
      let m
      IMPORT_RE.lastIndex = 0
      while ((m = IMPORT_RE.exec(src)) !== null) {
        const spec = m[1]
        if (!spec) continue
        if (spec.startsWith('.')) {
          // 只有运行期 src/** 不允许跑出插件目录；test/** 是开发期夹具，允许引用仓库根 packages
          if (inSrc) {
            const target = join(dirname(file), spec)
            if (!resolve(target).startsWith(resolve(codeDir) + '/')) report(`${rel} 的相对 import 跑出了本插件：${spec}`)
          }
          continue
        }
        const nm = /^@loomproxy\/(.+)$/.exec(spec)
        if (!nm) continue
        const dep = nm[1]
        if (dep !== 'plugins' && !ALLOW.plugins.includes(dep)) report(`${rel} 违反漏斗：plugins 依赖了 ${dep}`)
        if (inSrc) {
          // 只有 `import type ... from '@loomproxy/*'` 合法；值导入必须由宿主注入
          const head = src.slice(Math.max(0, m.index - 200), m.index)
          if (!/\bimport\s+type\b[^;]*$/.test(head)) {
            report(`${rel} 从 ${spec} 导入了运行时值：SDK 2 只能 import type，helper 用 sdk.*（由宿主注入）`)
          }
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
console.log('分层检查通过（依赖只许向下、插件自包含无软链、无 Go 代码）')
