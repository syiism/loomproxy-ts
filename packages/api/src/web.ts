// 面板静态托管：挂在**根路径**（`/` 与 `/*`），找不到文件回 index.html。
// `/panel` 已退役：只保留一个 301 到 `/`，让旧书签与文档里的老链接还能落地。
// 不引 @fastify/static：本轮只需要"读文件 + SPA 回退"，多一个依赖不划算。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Logger } from '@loomproxy/kernel'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

export type WebDeps = { webDir: string; logger: Logger }

/**
 * 面板路由清单（前端 router 的那份的镜像）。为什么需要它：
 * 面板挪到根之后，`/admin/monitor`、`/admin/users`、`/datasources` 这些**既是 API 又是面板页**。
 * 区分靠请求意图：浏览器地址栏/刷新发 text/html，面板自己的 fetch 发通配或 json。
 * —— 文档导航命中这张表就给面板；API 调用照旧给 JSON。
 * （注意：注释里别写星号斜杠连写，它会提前结束块注释——这一次就是被它咬到的）
 */
export const PANEL_PATHS = new Set([
  '/',
  '/login',
  '/register',
  '/forgot-password',
  '/dashboard',
  '/ranking',
  '/datasources',
  '/profile',
  '/404',
  '/admin',
  '/admin/users',
  '/admin/roles',
  '/admin/quotas',
  '/admin/redeem-codes',
  '/admin/datasources',
  '/admin/interfaces',
  '/admin/usage-logs',
  '/admin/monitor',
  '/admin/pools',
  '/admin/blocked-ips',
  '/admin/devices',
  '/admin/settings',
  '/admin/plugins',
])

/** 是不是"浏览器要一个页面"：Accept 里有 text/html，且路径是上面那张表里的（或表里的子路径） */
export function isPanelDocument(path: string, accept: string | undefined): boolean {
  if (!String(accept ?? '').includes('text/html')) return false
  const clean = path.split('?')[0] ?? path
  // 显式的文档端点（如 /admin/monitor/report.html）自己就是一张页面，别被面板清单吞掉：
  // 它要按自己的鉴权走（没登录 → 302 到 /login?next=…）
  if (clean.endsWith('.html')) return false
  if (PANEL_PATHS.has(clean)) return true
  for (const p of PANEL_PATHS) {
    if (p !== '/' && clean.startsWith(`${p}/`)) return true
  }
  return false
}

/** 面板入口：返回"读文件 + SPA 回退"的处理器（`/`、`/*`、`/assets/*` 与 dispatcher 的浏览器回退共用） */
export type SpaHandler = (req: { url: string }, reply: FastifyReply) => Promise<void>

export function registerWebRoutes(app: FastifyInstance, deps: WebDeps): SpaHandler {
  const root = resolve(deps.webDir)
  let warned = false

  const missingPanel = (reply: FastifyReply) => {
    if (!warned) {
      warned = true
      deps.logger.warn(`面板产物不在位: ${root}（构建: pnpm -F @loomproxy/web build）`)
    }
    reply
      .code(503)
      .send({ code: -1, msg: '面板尚未构建：pnpm -F @loomproxy/web build（产物目录 WEB_DIST）' })
  }

  const serve: SpaHandler = async (req: { url: string }, reply: FastifyReply) => {
    const path = req.url.split('?')[0] ?? '/'
    const rel = decodeURIComponent(path.replace(/^\//, ''))
    if (rel !== '' && !rel.includes('..')) {
      const file = normalize(join(root, rel))
      if (file.startsWith(`${root}/`) && existsSync(file) && statSync(file).isFile()) {
        reply.header('content-type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
        // 只有 Vite 的 hash 产物能长缓存；其余（index.html、favicon）一律不缓存
        reply.header('cache-control', rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
        reply.send(readFileSync(file))
        return
      }
    }
    const index = join(root, 'index.html')
    if (!existsSync(index)) return missingPanel(reply)
    reply.header('content-type', 'text/html; charset=utf-8')
    reply.header('cache-control', 'no-cache')
    reply.send(readFileSync(index))
  }

  // /panel 退役：旧链接 301 到 `/#/<其余>`（面板用 hash 路由，服务端只认 / 与 /assets/*）
  const legacy = async (req: { url: string }, reply: FastifyReply) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
    const rel = (req.url.split('?')[0] ?? '/panel').replace(/^\/panel\/?/, '')
    reply.code(301).header('location', `/${rel}${qs}`)
    reply.send()
  }
  app.get('/panel', legacy)
  app.get('/panel/*', legacy)

  // 静态资源单独一条：`/{source}/{action}` 是两段的数据面路由，`/*` 抢不过它，
  // 但 `/assets/*` 以静态段打头，优先级高于参数路由 —— 所以资源必须有自己的前缀
  app.get('/assets/*', serve)
  // 根：SPA（其余路径若没被更具体的路由接住，也回 index.html）
  app.get('/', serve)
  app.get('/*', serve)
  return serve
}
