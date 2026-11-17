#!/usr/bin/env node
// 面板—后端契约检查（对应 Go 版的 nav-check 那一族）：
// web/src/api/index.js 里每个 request('<path>') 都必须在后端路由表里找得到。
// 触发它的现场：面板调用点与后端各写一份路径，改名/漏实现时**构建和用例都不报**，
// 症状是"点开那一页弹一句 501/404"。这条把那份事实对上。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const WEB_API = join(ROOT, 'web', 'src', 'api', 'index.js')
const ROUTE_DIR = join(ROOT, 'packages', 'api', 'src')

// ---- 后端：抓 app.<method>('<path>' 与 stubs 数组里的 [method, path] ----
const backend = new Map() // path -> Set(method)
const addRoute = (method, path) => {
  const norm = path
  const set = backend.get(norm) ?? new Set()
  set.add(method.toLowerCase())
  backend.set(norm, set)
}
for (const f of readdirSync(ROUTE_DIR).filter((n) => n.startsWith('routes-') && n.endsWith('.ts'))) {
  const src = readFileSync(join(ROUTE_DIR, f), 'utf8')
  for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\(\s*[`'"]([^`'"]+)[`'"]/g)) {
    // 模板字面量里的 ${op} 是**循环变量的取值**（/admin/sources/:code/${op}），
    // 它匹配的是任意字面段（reload/rollback），不是参数名 —— 用 * 表示
    addRoute(m[1], m[2].replace(/\$\{[^}]*\}/g, '*'))
  }
  for (const m of src.matchAll(/\[\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*'([^']+)'/g)) addRoute(m[1], m[2])
}

// ---- 前端：把 `'/a/' + id + '/b'` 归一成 `/a/:p/b` ----
const webSrc = readFileSync(WEB_API, 'utf8')
const webCalls = []
for (const m of webSrc.matchAll(/request\(\s*([^,]+?)\s*,\s*\{/g)) {
  let expr = m[1].trim()
  // `encodeURIComponent(x)` 这类拼进路径的片段一律视为一个参数段
  expr = expr.replace(/encodeURIComponent\([^)]*\)/g, 'PARAM')
  const parts = expr.split('+').map((s) => s.trim())
  let path = ''
  for (const p of parts) {
    if (/^['"`].*['"`]$/.test(p)) {
      path += p.slice(1, p.endsWith('`') ? -1 : -1)
    } else {
      path += ':p'
    }
  }
  path = path.replace(/:p:/g, ':p/').replace(/\/:p$/, '/:p')
  if (path.startsWith('/')) webCalls.push({ path, call: m[0].slice(0, 40) })
}

// ---- 比对：段级匹配（后端 :id/前端 :p/模板段 * 都算通配）；允许后端多（非面板调用点） ----
// 两边的参数段名字不同（后端 :id / 前端 :p），统一成 :p 再比
const segs = (p) => p.split('/').filter(Boolean)
const isWild = (seg) => seg.startsWith(':') || seg === '*' || seg.startsWith('${')
const match = (route, call) => {
  const a = segs(route)
  const b = segs(call)
  if (a.length !== b.length) return false
  return a.every((seg, i) => isWild(seg) || isWild(b[i]) || seg === b[i])
}

let bad = 0
for (const w of webCalls) {
  if (![...backend.keys()].some((route) => match(route, w.path))) {
    console.error(`✗ 面板调用了后端没有的路径：${w.path}`)
    bad++
  }
}
if (bad > 0) {
  console.error(`\n面板—后端契约检查失败：${bad} 处`)
  process.exit(1)
}
console.log(`面板—后端契约检查通过（面板 ${webCalls.length} 个调用点，后端 ${backend.size} 条路由）`)
