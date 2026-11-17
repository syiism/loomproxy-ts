// 面板静态托管（与 Go 版同契约：`/panel` 与 `/panel/*` 都回 SPA，找不到文件回 index.html）。
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

export function registerWebRoutes(app: FastifyInstance, deps: WebDeps): void {
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

  const serve = async (req: { url: string }, reply: FastifyReply) => {
    const path = req.url.split('?')[0] ?? '/panel'
    const rel = decodeURIComponent(path.replace(/^\/panel\/?/, ''))
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

  app.get('/panel', serve)
  app.get('/panel/*', serve)
  // 根路径上给个入口，便于人肉点开（Go 版 `/` 回 JSON，这里保持 JSON 且指向 /panel）
}
