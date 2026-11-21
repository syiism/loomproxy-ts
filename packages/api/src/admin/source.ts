// 管理面 · 数据源域：数据源、默认地址、分组、定时启停、号池。

import type { FastifyInstance } from 'fastify'
import { fail, ok } from '@loomproxy/contract'
import { rankPublicSet, setRankPublic } from './shared.ts'
import type { AdminContext } from './shared.ts'

export function registerSourceRoutes(app: FastifyInstance, deps: AdminContext): void {
  const { config, stores, guard, unavailable } = deps

  // ---- 数据源 ----
  // 数据源 = **配置/授权主体**（分组、额度授权对象、榜单名单、启停），插件 = 它背后的实现。
  // 两者用 code 关联：这一页把"装没装插件"投影出来（installed/plugin_*），
  // 否则面板上"数据源存在"与"能用"是两件事却看不出来。
  const pluginOf = (code: string) => {
    const entry = deps.host?.registryRef.get(code)
    if (!entry) return undefined
    return { version: entry.version, state: entry.state, actions: entry.meta.actions, isolation: entry.isolation }
  }
  app.get('/admin/data-sources', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const ds = stores.dataSources as unknown as { listAll?: () => Array<Record<string, unknown>> }
    // 面板读 ds.rank_public（榜单开关的当前态）与 group_id/group_name（分组列）
    const rank = rankPublicSet(stores.settings)
    const groups = stores.sourceGroups?.list() ?? []
    return ok(
      (ds?.listAll?.() ?? []).map((row) => {
        const plugin = pluginOf(String(row['name']))
        return {
          ...row,
          rank_public: rank.has(String(row['name'])),
          group_name: groups.find((g) => g.id === Number(row['group_id'] ?? 0))?.name ?? '',
          installed: plugin !== undefined,
          ...(plugin
            ? {
                plugin_version: plugin.version,
                plugin_state: plugin.state,
                plugin_isolation: plugin.isolation,
                actions: plugin.actions,
              }
            : { actions: [] as string[] }),
        }
      }),
    )
  })
  // 「新增数据源」= 登记一个**配置位**（分组/排序/启停/榜单/以后授权），它不含实现。
  // 这一点必须说清楚：没有对应插件时，`/datasources` 目录里不会出现它、数据面 /{code}/* 回 404
  // not_found。过去这里只写一行库、什么也不说，面板看着像"加了一个源"（2026-11-18 现场）。
  // 真正的"上新一个源"是「源插件 → 添加插件」：插件加载时会 upsert 这一行。
  app.post('/admin/data-sources', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { name?: string; display_name?: string; category?: string; description?: string; sort_order?: number; status?: number }
    if (!b.name || !b.display_name) {
      reply.code(400).send(fail(config.errorCode, '缺少源码或显示名'))
      return
    }
    if (!/^[a-z0-9_]+$/.test(b.name)) {
      reply.code(400).send(fail(config.errorCode, '源码只允许小写字母/数字/下划线（与插件 manifest 的 code 同约束）'))
      return
    }
    const ds = stores.dataSources as unknown as {
      create?: (i: never) => number
      listAll?(): Array<{ name: string }>
    }
    if (!ds?.create) return unavailable(reply, '数据源存储未接')
    if (ds.listAll?.().some((r) => r.name === b.name)) {
      reply.code(400).send(fail(config.errorCode, `数据源 ${b.name} 已存在`))
      return
    }
    const id = ds.create({ ...b, name: b.name, display_name: b.display_name } as never)
    const installed = deps.host?.registryRef.get(b.name) !== undefined
    return ok({
      id,
      name: b.name,
      installed,
      msg: installed
        ? '已登记这一行配置'
        : `已登记配置位 ${b.name}，但还没有插件实现它：数据面 /${b.name}/* 在装好插件前回 404。请到「源插件 → 添加插件」安装实现`,
    })
  })
  app.patch('/admin/data-sources/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const dsStore = deps.dataSources as unknown as {
      get?(name: string): unknown
      listAll?(): Array<{ id: number; name: string }>
      update?(id: number, patch: Record<string, unknown>): void
    }
    if (!dsStore?.update) return unavailable(reply, '数据源存储未接')
    const row = dsStore.listAll?.().find((d) => d.id === Number(id))
    if (!row) {
      reply.code(404).send(fail(config.errorCode, '数据源不存在'))
      return
    }
    const body = (req.body ?? {}) as {
      display_name?: string
      category?: string
      description?: string
      status?: number
      sort_order?: number
      group_id?: number
      clear_group?: boolean
      rank_public?: boolean
    }
    if (body.group_id !== undefined && body.clear_group) {
      reply.code(400).send(fail(config.errorCode, 'group_id 与 clear_group 不能同时给'))
      return
    }
    const patch: Record<string, unknown> = {}
    for (const k of ['display_name', 'category', 'description', 'sort_order'] as const) {
      if (body[k] !== undefined) patch[k] = body[k]
    }
    if (body.status !== undefined) {
      if (body.status !== 0 && body.status !== 1) {
        reply.code(400).send(fail(config.errorCode, 'status 只能是 0 或 1'))
        return
      }
      patch['status'] = body.status
    }
    if (body.clear_group) patch['group_id'] = null
    else if (body.group_id !== undefined) {
      if (!stores.sourceGroups?.list().some((g) => g.id === body.group_id)) {
        reply.code(400).send(fail(config.errorCode, '分组不存在'))
        return
      }
      patch['group_id'] = body.group_id
    }
    if (Object.keys(patch).length === 0 && body.rank_public === undefined) {
      reply.code(400).send(fail(config.errorCode, '无更新字段'))
      return
    }
    dsStore.update(Number(id), patch)
    const rankPublic = body.rank_public === undefined ? rankPublicSet(stores.settings).has(row.name) : setRankPublic(stores.settings, row.name, body.rank_public)
    const fresh = dsStore.listAll?.().find((d) => d.id === Number(id)) ?? row
    return ok({ ...fresh, rank_public: rankPublic })
  })
  app.delete('/admin/data-sources/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const dsStore = deps.dataSources as unknown as {
      listAll?(): Array<{ id: number; name: string }>
      remove?(id: number): boolean
      removeWithRefs?(id: number, name: string): boolean
    }
    const row = dsStore?.listAll?.().find((d) => d.id === Number(id))
    if (!row) {
      reply.code(404).send(fail(config.errorCode, '数据源不存在'))
      return
    }
    // 级联删除：套餐授权/接口成本/用户覆盖/定时/源配置/名称缓存一起清掉，不留下指向空源的垃圾行。
    // 历史调用日志与额度流水是账本，保留（见 DbDataSources.removeWithRefs）。
    dsStore.removeWithRefs?.(Number(id), row.name) ?? dsStore.remove?.(Number(id))
    // 顺手把它从公开榜放行名单里摘掉（源都没了，留着只会让名单越长越脏）
    try {
      setRankPublic(stores.settings, row.name, false)
    } catch {
      /* 设置存储不可用时不影响删除结果 */
    }
    return ok({ removed: true, source: row.name })
  })

  // 平台默认地址（个人级在 /user/source-configs）：回落顺序 个人 → 平台 → 源内置
  app.get('/admin/source-configs', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const cfg = stores.sourceConfigs
    if (!cfg) return unavailable(reply, '数据源默认地址存储未接')
    const map = cfg.platform()
    const dsStore = deps.dataSources as unknown as { listAll?: () => Array<{ name: string; display_name: string }> }
    const items = (dsStore?.listAll?.() ?? []).map((ds) => ({
      source_name: ds.name,
      source_display: ds.display_name,
      base_url: map[ds.name] ?? '',
    }))
    return ok(items)
  })
  app.put('/admin/source-configs', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const cfg = stores.sourceConfigs
    if (!cfg) return unavailable(reply, '数据源默认地址存储未接')
    const b = (req.body ?? {}) as { configs?: Array<{ source_name?: string; base_url?: string }> }
    for (const c of b.configs ?? []) {
      if (!c.source_name) continue
      cfg.setPlatform(c.source_name, (c.base_url ?? '').trim())
    }
    return ok({})
  })

  // ---- 数据源分组（视图 + 批量授权单位，不参与键控） ----
  app.get('/admin/source-groups', async (req, reply) => {
    if (!(await guard(req, reply))) return
    // 面板读 res.groups / res.ungrouped_count（不是裸数组）；形状照 Go 的 ListSourceGroups
    const groups = stores.sourceGroups
    if (!groups) return unavailable(reply, '分组存储未接')
    return ok({ groups: groups.list(), ungrouped_count: groups.ungroupedCount() })
  })
  app.post('/admin/source-groups', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { name?: string; sort_order?: number }
    if (!b.name) {
      reply.code(400).send(fail(config.errorCode, '缺少分组名'))
      return
    }
    const groups = stores.sourceGroups
    if (!groups) return unavailable(reply, '分组存储未接')
    const b2 = b as { name?: string; description?: string; sort_order?: number }
    return ok(
      groups.create({
        name: b2.name as string,
        ...(b2.description !== undefined ? { description: b2.description } : {}),
        ...(b2.sort_order !== undefined ? { sort_order: b2.sort_order } : {}),
      }),
    )
  })
  app.patch('/admin/source-groups/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; description?: string; sort_order?: number; status?: number }
    return ok(stores.sourceGroups?.update(Number(id), b) ?? {})
  })
  app.delete('/admin/source-groups/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    stores.sourceGroups?.remove(Number(id))
    return ok({})
  })
  app.put('/admin/source-groups/:id/members', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { source_names?: string[] }
    const groups = stores.sourceGroups
    if (!groups) return unavailable(reply, '分组存储未接')
    return ok({ moved: groups.setMembers(Number(id), b.source_names ?? []) })
  })
  app.post('/admin/source-groups/:id/apply-limits', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { plan_id?: number; limit?: number }
    if (!b.plan_id) {
      reply.code(400).send(fail(config.errorCode, '缺少 plan_id'))
      return
    }
    const groups = stores.sourceGroups
    if (!groups) return unavailable(reply, '分组存储未接')
    return ok({ applied: groups.applyLimits(Number(id), b.plan_id, b.limit ?? 0) })
  })

  // ---- 数据源定时启停（到点自动启用；窗口外的一次性规则收尾） ----
  app.get('/admin/source-schedules', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const sched = stores.schedules
    if (!sched) return unavailable(reply, '定时规则存储未接')
    return ok(sched.list(config.tzOffsetHours))
  })
  app.post('/admin/source-schedules', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const sched = stores.schedules
    if (!sched) return unavailable(reply, '定时规则存储未接')
    const b = (req.body ?? {}) as {
      source_ids?: number[]
      mode?: 'daily' | 'once'
      start_clock?: string
      end_clock?: string
      start_at?: string
      duration_min?: number
    }
    if (!b.source_ids?.length) {
      reply.code(400).send(fail(config.errorCode, '请至少选择一个数据源'))
      return
    }
    const created = sched.create({
      sourceIds: b.source_ids,
      mode: b.mode === 'once' ? 'once' : 'daily',
      ...(b.start_clock ? { startClock: b.start_clock } : {}),
      ...(b.end_clock ? { endClock: b.end_clock } : {}),
      ...(b.start_at ? { startAt: b.start_at } : {}),
      ...(b.duration_min !== undefined ? { durationMin: b.duration_min } : {}),
    })
    return ok({ created })
  })
  app.patch('/admin/source-schedules/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const sched = stores.schedules
    if (!sched) return unavailable(reply, '定时规则存储未接')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { start_clock?: string; end_clock?: string; start_at?: string | null; duration_min?: number; status?: number }
    sched.update(Number(id), b)
    return ok({})
  })
  app.delete('/admin/source-schedules/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    stores.schedules?.remove(Number(id))
    return ok({})
  })

  // ---- 号池（packages/pool 的运行期快照；没有池时是空列表） ----
  app.get('/admin/pools', async (req, reply) => {
    if (!(await guard(req, reply))) return
    return ok(stores.pools?.statusAll() ?? [])
  })
}
