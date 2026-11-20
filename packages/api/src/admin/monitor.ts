// 管理面 · 监控域：接口监控、报表、内容维度、公开榜。

import type { FastifyInstance } from 'fastify'
import { MEDIA, RANK_BOARDS, fail, isValidMedia, isValidSubjectDim, mediaLabel, ok, type RankBoard, type SubjectCoverageRow, type SubjectItem } from '@loomproxy/contract'
import { clampPage, clampPageSize } from '@loomproxy/kernel'
import { resolveIdentity } from './auth.ts'
import { displayName, MONITOR_STARTED_AT, rankPublicSet, windowSince } from './admin-shared.ts'
import type { AdminContext } from './admin-shared.ts'

export function registerMonitorRoutes(app: FastifyInstance, deps: AdminContext): void {
  const { config, stores, guard, unavailable } = deps

  // ---- 监控 ----
  app.get('/admin/monitor', async (req, reply) => {
    if (!(await guard(req, reply))) return
    // 面板「接口监控」读的是 Go 那一套完整形状（started_at/total/success/failed/success_rate/
    // lifetime_total/items/recent），不是 {stats,total}。TS 用 api_call_stats 的累计读数做口径：
    // 每个源/动作一行，total=success+failed，avg=总延迟/total，lifetime 就是累计值。
    // recent 取最近 50 条明细。这样各格不再是 0/空，"总调用"也不再错用 DB 明细行数。
    // 口径（与 Go 一致）：total/success/items[].total = 服务启动以来的窗口计数（重启清零），
    // lifetime_total/items[].lifetime = 历史累计（api_call_stats）。两者不能混用——
    // 之前错把历史累计当 total，却把 started_at 写成启动时刻，面板上与"统计起点"自相矛盾。
    const win = stores.callLogs?.windowStats?.(MONITOR_STARTED_AT) ?? []
    const stats = (stores.callLogs as unknown as { stats?: () => Array<Record<string, unknown>> })?.stats?.() ?? []
    const num = (v: unknown) => Number(v ?? 0)
    const lifetimeByKey = new Map<string, number>()
    let lifetimeTotal = 0
    for (const r of stats) {
      const t = num(r['total'])
      lifetimeByKey.set(`${r['source']}/${r['action']}`, t)
      lifetimeTotal += t
    }
    let total = 0, success = 0
    const items = win.map((r) => {
      total += r.total
      success += r.success
      return {
        source: r.source,
        action: r.action,
        total: r.total,
        success: r.success,
        failed: r.failed,
        success_rate: r.total > 0 ? (r.success / r.total) * 100 : 0,
        avg_latency_ms: r.total > 0 ? Math.round(r.total_latency_ms / r.total) : 0,
        max_latency_ms: r.max_latency_ms,
        lifetime: lifetimeByKey.get(`${r.source}/${r.action}`) ?? r.total,
        last_called_at: r.last_called_at || null,
      }
    })
    const failed = total - success
    // 面板「最近调用」读 Go 的 RecentCall 形状：time/username/media 等；TS 明细行是
    // created_at/media_type，字段名不同会导致时间空、媒介空。这里按 Go 字段名对齐。
    // 老数据里 API Key 调用的 username 被写成 #user_id，查 users 补真实名（新数据已在 auth.ts 源头修）。
    const rawRecent = (stores.callLogs?.page({ page: 1, pageSize: 50 })?.list ?? []).slice(0, 50)
    const idNames = new Map<number, string>()
    for (const r of rawRecent) {
      const m = /^#(\d+)$/.exec(r.username)
      if (m) {
        const uid = Number(m[1])
        if (!idNames.has(uid)) {
          const u = stores.users?.byId(uid)
          if (u?.username) idNames.set(uid, u.username)
        }
      }
    }
    const recent = rawRecent.map((r) => ({
      time: r.created_at,
      username: displayName(r.username, idNames),
      ip: r.ip || '',
      source: r.source,
      action: r.action,
      status: r.status,
      in_band_error: r.in_band_error,
      in_band_reason: r.in_band_reason,
      in_band_code: r.in_band_code,
      latency_ms: r.latency_ms,
      keyword: r.keyword,
      book_name: r.book_name,
      chapter_title: r.chapter_title,
      book_ident: r.book_ident,
      chapter_ident: r.chapter_ident,
      media: r.media_type,
      result_count: r.result_count,
    }))
    return ok({
      started_at: MONITOR_STARTED_AT,
      total,
      success,
      failed,
      success_rate: total > 0 ? (success / total) * 100 : 0,
      lifetime_total: lifetimeTotal,
      items,
      recent,
      name_store_persistent: false,
    })
  })

  app.get('/admin/monitor/history', async (req, reply) => {
    if (!(await guard(req, reply))) return
    if (!stores.callLogs) return unavailable(reply, '调用明细存储未接')
    const q = req.query as Record<string, string>
    return ok(
      stores.callLogs.page({
        page: clampPage(q['page']),
        pageSize: clampPageSize(q['page_size']),
        ...(q['source'] ? { source: q['source'] } : {}),
        ...(q['action'] ? { action: q['action'] } : {}),
        ...(q['username'] ? { username: q['username'] } : {}),
        ...(q['plugin_version'] ? { pluginVersion: q['plugin_version'] } : {}),
        ...(q['in_band_code'] ? { inBandCode: q['in_band_code'] } : {}),
        ...(q['media_type'] ? { mediaType: q['media_type'] } : {}),
        ...(q['keyword'] ? { keyword: q['keyword'] } : {}),
        ...(q['book_name'] ? { bookName: q['book_name'] } : {}),
        ...(q['chapter_title'] ? { chapterTitle: q['chapter_title'] } : {}),
      }),
    )
  })

  // 内容维度榜（管理端）：面板「监控 → 内容维度」读 `data.items` / `data.coverage` / `data.name_cache`。
  // 回裸数组会让整段（含覆盖率体检与缓存读数）一起空白——与「设置页空白」是同一族错。
  app.get('/admin/monitor/subjects', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = req.query as Record<string, string>
    if (!stores.callLogs) return unavailable(reply, '调用明细存储未接')
    const dim = (q['dim'] ?? 'keyword').trim().toLowerCase()
    if (!isValidSubjectDim(dim)) {
      reply.code(400).send(fail(config.errorCode, 'dim 只接受 keyword/book/chapter/media'))
      return
    }
    // 天数收敛：越界回落 7，上限 365（与 Go 的 NormalizeDays 同口径）
    const rawDays = Math.trunc(Number(q['days'] ?? 7) || 7)
    const days = rawDays < 1 || rawDays > 365 ? 7 : rawDays
    const media = (q['media'] ?? '').trim()
    if (media && !isValidMedia(media)) {
      reply.code(400).send(fail(config.errorCode, 'media 不是合法媒介（novel/audio/comic/video）'))
      return
    }
    const source = (q['source'] ?? '').trim()
    const since = windowSince(config.tzOffsetHours, days)
    const items = stores.callLogs.subjects({ dim, since, ...(source ? { source } : {}), ...(media ? { media } : {}), limit: 50 })
    // 覆盖率统计失败不该让整页挂掉：榜本身还能看，失败由 coverage_error 如实说出来
    let coverage: SubjectCoverageRow[] = []
    let coverageError = false
    try {
      coverage = stores.callLogs.coverage({ since, ...(source ? { source } : {}) })
    } catch {
      coverageError = true
    }
    return ok({
      dim,
      days,
      from: since,
      items,
      coverage,
      coverage_error: coverageError,
      name_cache: stores.nameCache?.stats() ?? { books: 0, chapters: 0 },
    })
  })

  app.post('/admin/monitor/reset', async (req, reply) => {
    if (!(await guard(req, reply))) return
    stores.callLogs?.clear()
    return ok({})
  })

  // 服务端现出一份独立报表（内存渲染、不落盘）：运维要能把"这一小时的读数"整页导出/发人
  app.get('/admin/monitor/report.html', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const logs = stores.callLogs as unknown as {
      stats?: () => Array<{ source: string; action: string; total: number; success: number; failed: number; total_latency_ms: number; max_latency_ms: number }>
    }
    const rows = logs?.stats?.() ?? []
    const total = rows.reduce((n, r) => n + r.total, 0)
    const failed = rows.reduce((n, r) => n + r.failed, 0)
    const esc = (v: unknown) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
    const body = rows
      .map(
        (r) =>
          `<tr><td>${esc(r.source)}</td><td>${esc(r.action)}</td><td>${r.total}</td><td>${r.success}</td><td>${r.failed}</td>` +
          `<td>${r.total ? Math.round(r.total_latency_ms / r.total) : 0}ms</td><td>${r.max_latency_ms}ms</td></tr>`,
      )
      .join('')
    reply.header('content-type', 'text/html; charset=utf-8')
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>LoomProxy 监控报表</title>
<style>body{font:14px/1.6 -apple-system,"PingFang SC",sans-serif;margin:24px;color:#1f2328}
table{border-collapse:collapse;font-size:13px}td,th{border-bottom:1px solid #e3e6ea;padding:6px 10px;text-align:left}
h1{font-size:18px}code{font-family:ui-monospace,Menlo,monospace}</style>
<h1>LoomProxy 监控报表</h1>
<p>生成时间 <code>${esc(new Date().toISOString())}</code>　合计 <b>${total}</b> 次调用，失败 <b>${failed}</b> 次。</p>
<table><thead><tr><th>数据源</th><th>接口</th><th>总数</th><th>成功</th><th>失败</th><th>平均耗时</th><th>最慢</th></tr></thead>
<tbody>${body || '<tr><td colspan="7">暂无读数</td></tr>'}</tbody></table>
<p style="color:#6b7280">读数来自 api_call_stats 聚合表（明细可清、聚合留）。</p></html>`
  })

  app.get('/admin/monitor/trend', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const qs = req.query as Record<string, string>
    const days = Math.max(1, Number(qs['days'] ?? 7) || 7)
    const logs = stores.callLogs as unknown as { trend?: (d: number) => unknown[] }
    return ok(logs?.trend?.(days) ?? [])
  })
  app.post('/admin/monitor/backfill-subjects', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const cache = stores.nameCache as unknown as { backfill?: () => { books: number; chapters: number } }
    if (!cache?.backfill) return unavailable(reply, '命名缓存未接')
    return ok(cache.backfill())
  })

  // ---- 公开榜（登录用户可读） ----
  // 形状与 Go 的 handlers/rank 一致：面板读 `data.boards[].rows[]` 与 `data.sources/medias`。
  // 只给名称/次数（阅读榜另带书目标识），**不给**时间与用户——明细是敏感数据，
  // 排障视角（成功率/耗时/来源）只在管理端那张榜上。
  app.get('/rank/boards', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    if (!stores.callLogs) return unavailable(reply, '调用明细存储未接')
    const q = req.query as Record<string, string>
    const isAdmin = id.roles.includes('admin')
    // 白名单留空 = 不对普通用户开放任何榜单；管理员始终能看（否则开关一关，自己也没法验证）
    const allow = isAdmin ? undefined : [...rankPublicSet(stores.settings)]
    if (allow !== undefined && allow.length === 0) {
      reply.code(403).send(fail(403, '榜单未开放'))
      return
    }
    const rawDays = Number(q['days'] ?? 7)
    const days = rawDays === 1 || rawDays === 7 || rawDays === 30 ? rawDays : 7
    let sourceFilter = (q['source'] ?? '').trim()
    // 候选源只取启用中的（下架一个源，下拉框里不该还留着它）
    let sources = (deps.dataSources?.listEnabled() ?? []).map((r) => ({ code: r.name, name: r.display_name }))
    if (sourceFilter) {
      if (!sources.some((o) => o.code === sourceFilter)) {
        reply.code(400).send(fail(400, 'source 不是启用中的数据源'))
        return
      }
      if (allow !== undefined && !allow.includes(sourceFilter)) {
        reply.code(403).send(fail(403, '该数据源的榜单未开放'))
        return
      }
    }
    const mediaFilter = (q['media'] ?? '').trim()
    if (mediaFilter && !isValidMedia(mediaFilter)) {
      reply.code(400).send(fail(400, 'media 不是合法媒介（novel/audio/comic/video）'))
      return
    }
    // 非管理员看到的候选也只剩被开放的源——列未开放的源本身就是信息
    if (allow !== undefined) sources = sources.filter((o) => allow.includes(o.code))

    const ttlSec = Math.max(0, config.rankCacheSec)
    const cacheKey = `${isAdmin ? 'all' : `pub:${[...(allow ?? [])].sort().join(',')}`}:${days}:${sourceFilter}:${mediaFilter}`
    let boards = ttlSec > 0 ? deps.boardsCache.get(cacheKey) : undefined
    if (!boards) {
      const since = windowSince(config.tzOffsetHours, days)
      boards = RANK_BOARDS.map((b): RankBoard => {
        const items: SubjectItem[] = stores.callLogs!.subjects({
          dim: b.dim,
          since,
          ...(sourceFilter ? { source: sourceFilter } : {}),
          ...(mediaFilter ? { media: mediaFilter } : {}),
          limit: 20,
          ...(allow !== undefined ? { allowSources: allow } : {}),
        })
        return {
          dim: b.dim,
          title: b.title,
          unit: b.unit,
          metric: b.metric,
          rows: items.filter((it) => it.name !== '').map((it) => ({
            name: it.name,
            total: it.total,
            ...(it.book_id ? { book_id: it.book_id } : {}),
          })),
        }
      })
      // 写不进缓存最坏只是"下次照样真算"；只缓存榜单行，不缓存 sources/medias（那是数据源表的当前态）
      if (ttlSec > 0) deps.boardsCache.set(cacheKey, boards)
    }
    return ok({
      days,
      boards,
      limit: 20,
      source: sourceFilter,
      sources,
      unrestricted: isAdmin,
      media: mediaFilter,
      medias: MEDIA.map((value) => ({ value, label: mediaLabel(value) })),
      cache_ttl_sec: ttlSec,
    })
  })
}
