// 管理面 · 静态文件：管理 DATA_DIR/<source>/ 下的 JSON 字典、legado 书源与版本日志。
// 只允许管理员；所有路径先过白名单再落盘，绝不把用户给的相对路径直接拼进 fs。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, resolve as resolvePath, sep } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { fail, ok } from '@loomproxy/contract'
import type { AdminContext } from './shared.ts'

const SOURCE_RE = /^[A-Za-z0-9_-]{1,64}$/
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SKIP_DIRS = new Set(['_runtime', '_archive'])
const RETIRED_SOURCES = new Set(['xmly', 'huanmeng', 'wd', 'uxx', 'zj'])

type FileInfo = {
  name: string; filename: string; size: number; mtime: string; servable: boolean
  category: string; retired: boolean
}

function categoryOf(source: string, filename: string): string {
  if (filename.includes('.bak-')) return '备份'
  if (filename === 'bookSource.json') return 'legado 书源'
  if (filename === 'version.json') return '版本日志'
  if (/(cats|ranks|tags|category)/i.test(filename)) return '分类静态数据'
  if (RETIRED_SOURCES.has(source)) return '退役源文件'
  return '其他'
}

function fileInfo(root: string, source: string, filename: string): FileInfo {
  let size = 0
  let mtime = ''
  try {
    const st = statSync(join(root, source, filename))
    size = st.size
    mtime = new Date(st.mtimeMs).toISOString()
  } catch { /* 读不到就按 0 展示，不让一列失败拖垮整页 */ }
  return {
    name: filename.replace(/\.json$/i, ''),
    filename,
    size,
    mtime,
    servable: filename.toLowerCase().endsWith('.json'),
    category: categoryOf(source, filename),
    retired: RETIRED_SOURCES.has(source),
  }
}

export function registerStaticFileRoutes(app: FastifyInstance, ctx: AdminContext): void {
  const root = resolvePath(ctx.config.dataDir)
  const knownSources = () => (ctx.dataSources as unknown as {
    listAll?: () => Array<{ name: string; display_name?: string }>
  }).listAll?.() ?? []

  /** 解析并校验 DATA_DIR/<source>/<name>；返回 null 表示请求非法（路由层回 400）。 */
  const targetOf = (source: string, name: string): string | null => {
    if (!SOURCE_RE.test(source) || SKIP_DIRS.has(source)) return null
    if (!NAME_RE.test(name) || name.includes('..') || name.startsWith('.')) return null
    const target = normalize(join(root, source, name))
    if (!target.startsWith(root + sep)) return null
    return target
  }

  // 源目录改名：整个 DATA_DIR/<source>/ 一起迁移；会影响 /data/<source>/... 的既有 URL
  app.post('/admin/static-files/rename-source', async (req, reply) => {
    if (!(await ctx.guard(req, reply))) return
    const b = (req.body ?? {}) as { from?: string; to?: string }
    const from = String(b.from ?? ''), to = String(b.to ?? '')
    const valid = (s: string) => SOURCE_RE.test(s) && !SKIP_DIRS.has(s) && !s.startsWith('.')
    if (!valid(from) || !valid(to)) {
      reply.code(400).send(fail(ctx.config.errorCode, '非法的源名'))
      return
    }
    const fromDir = normalize(join(root, from)), toDir = normalize(join(root, to))
    if (!fromDir.startsWith(root + sep) || !toDir.startsWith(root + sep)) {
      reply.code(400).send(fail(ctx.config.errorCode, '非法的源名'))
      return
    }
    const known = knownSources().some((s) => s.name === from)
    if (!existsSync(fromDir) && !known) {
      reply.code(404).send(fail(ctx.config.errorCode, '源不存在，也没有静态目录'))
      return
    }
    if (fromDir !== toDir && existsSync(toDir)) {
      reply.code(400).send(fail(ctx.config.errorCode, '目标源目录已存在'))
      return
    }
    if (fromDir !== toDir) {
      // 源已登记但还没建过静态目录：直接按给定名字建一个空目录，之后就能往里放分类文件
      if (!existsSync(fromDir)) mkdirSync(toDir, { recursive: true })
      else renameSync(fromDir, toDir)
    }
    return ok({ from, to })
  })

  app.get('/admin/static-files', async (req, reply) => {
    if (!(await ctx.guard(req, reply))) return
    const sources = []
    if (existsSync(root)) {
      for (const d of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!d.isDirectory() || d.name.startsWith('.') || SKIP_DIRS.has(d.name) || !SOURCE_RE.test(d.name)) continue
        const files = readdirSync(join(root, d.name))
          .filter((n) => NAME_RE.test(n) && !n.startsWith('.'))
          .sort((a, b) => a.localeCompare(b))
          .map((n) => fileInfo(root, d.name, n))
        sources.push({ source: d.name, file_count: files.length, files })
      }
    }
    const dirNames = new Set(sources.map((s) => s.source))
    const known = knownSources().map((s) => ({
      code: s.name, name: s.display_name || s.name, has_dir: dirNames.has(s.name),
    }))
    return ok({
      count: sources.length, sources, known_sources: known,
      retired_sources: [...RETIRED_SOURCES],
    })
  })

  app.get('/admin/static-files/:source/:name', async (req, reply) => {
    if (!(await ctx.guard(req, reply))) return
    const { source, name } = req.params as { source: string; name: string }
    const target = targetOf(source, name)
    if (!target) {
      reply.code(400).send(fail(ctx.config.errorCode, '非法的源名或文件名'))
      return
    }
    if (!existsSync(target)) {
      reply.code(404).send(fail(ctx.config.errorCode, '静态文件不存在'))
      return
    }
    return ok({ source, content: readFileSync(target, 'utf8'), ...fileInfo(root, source, name) })
  })

  // 改名/换源：编辑面板允许改源名与文件名，服务端校验两端路径后原子移动
  app.post('/admin/static-files/move', async (req, reply) => {
    if (!(await ctx.guard(req, reply))) return
    const b = (req.body ?? {}) as { fromSource?: string; fromName?: string; toSource?: string; toName?: string }
    const from = targetOf(String(b.fromSource ?? ''), String(b.fromName ?? ''))
    const to = targetOf(String(b.toSource ?? ''), String(b.toName ?? ''))
    if (!from || !to) {
      reply.code(400).send(fail(ctx.config.errorCode, '非法的源名或文件名'))
      return
    }
    if (!existsSync(from)) {
      reply.code(404).send(fail(ctx.config.errorCode, '静态文件不存在'))
      return
    }
    if (from !== to && existsSync(to)) {
      reply.code(400).send(fail(ctx.config.errorCode, '目标文件已存在'))
      return
    }
    if (from !== to) {
      mkdirSync(dirname(to), { recursive: true })
      renameSync(from, to)
    }
    const toSource = String(b.toSource ?? '')
    const toName = String(b.toName ?? '')
    return ok({ source: toSource, ...fileInfo(root, toSource, toName) })
  })

  // 文本编辑/上传共用：面板把文件读成文本提交，服务端原子替换，避免半截文件被 /data 读到
  app.put('/admin/static-files/:source/:name', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    if (!(await ctx.guard(req, reply))) return
    const { source, name } = req.params as { source: string; name: string }
    const body = (req.body ?? {}) as { content?: string }
    if (typeof body.content !== 'string') {
      reply.code(400).send(fail(ctx.config.errorCode, '缺少 content（文件内容文本）'))
      return
    }
    const target = targetOf(source, name)
    if (!target) {
      reply.code(400).send(fail(ctx.config.errorCode, '非法的源名或文件名'))
      return
    }
    mkdirSync(join(root, source), { recursive: true })
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
    try {
      writeFileSync(tmp, body.content, 'utf8')
      renameSync(tmp, target)
    } catch {
      try { unlinkSync(tmp) } catch { /* 临时文件可能压根没建出来 */ }
      throw new Error('写静态文件失败')
    }
    return ok({ source, ...fileInfo(root, source, name) })
  })

  app.delete('/admin/static-files/:source/:name', async (req, reply) => {
    if (!(await ctx.guard(req, reply))) return
    const { source, name } = req.params as { source: string; name: string }
    const target = targetOf(source, name)
    if (!target) {
      reply.code(400).send(fail(ctx.config.errorCode, '非法的源名或文件名'))
      return
    }
    if (!existsSync(target)) {
      reply.code(404).send(fail(ctx.config.errorCode, '静态文件不存在'))
      return
    }
    unlinkSync(target)
    return ok({ source, name })
  })
}
