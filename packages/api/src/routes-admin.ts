// 管理面：总览读数、用户、角色、套餐、设置、数据源、监控、号池(空)、公开榜。
// 额度/卡密/分组/定时/IP/设备/接口消耗属"未接域"：显式 501 并说清是哪个域，
// 面板会把 msg 原样 toast 出来——不假造成功。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { fail, ok } from '@loomproxy/contract'
import { clampPage, clampPageSize } from '@loomproxy/kernel'
import type { Config } from '@loomproxy/kernel'
import { resolveIdentity } from './auth.ts'
import { resetAttempts, snapshot } from './login-limiter.ts'
import type { DataSourceStore } from '@loomproxy/store'
import type { SourceHost } from '@loomproxy/source-host'
import { notWired, type ApiStores } from './stores.ts'

type Deps = { config: Config; stores: ApiStores; dataSources?: DataSourceStore; host?: SourceHost }

async function requireAdmin(req: FastifyRequest, reply: FastifyReply, deps: Deps) {
  const id = await resolveIdentity(req, deps.config, {
    ...(deps.stores.sessions ? { sessions: deps.stores.sessions } : {}),
    ...(deps.stores.apiKeys ? { apiKeys: deps.stores.apiKeys } : {}),
    ...(deps.stores.users ? { users: deps.stores.users } : {}),
  })
  if (!id.roles.includes('admin')) {
    reply.code(403).send(fail(deps.config.errorCode, '需要管理员权限'))
    return undefined
  }
  return id
}

/** 公开榜单放行名单存在设置项 rank_public_sources 里（逗号分隔），不是源行上的列 */
function rankPublicSet(settings?: { get(key: string): string }): Set<string> {
  const raw = (settings?.get('rank_public_sources') ?? '').trim()
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
}

function setRankPublic(settings: { get(key: string): string; set(key: string, v: string): void } | undefined, source: string, on: boolean): boolean {
  if (!settings) throw new Error('设置存储未接')
  const set = rankPublicSet(settings)
  if (on) set.add(source)
  else set.delete(source)
  settings.set('rank_public_sources', [...set].sort().join(','))
  return on
}

/** 下次清零时刻（平台时区下一个 0 点），形状与 Go 的 nextResetTime 一致：2026/11/18 00:00:00 */
function nextResetLabel(tzOffsetHours: number): string {
  const offsetMs = tzOffsetHours * 3600_000
  const local = Date.now() + offsetMs
  const next = (Math.floor(local / 86_400_000) + 1) * 86_400_000 - offsetMs
  // next 是 UTC 时刻；要显示的是**平台时区**的钟点，所以把位移加回去再读 UTC 分量
  const d = new Date(next + offsetMs)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`
}

export function registerAdminRoutes(app: FastifyInstance, deps: Deps): void {
  const { config, stores } = deps
  const unavailable = (reply: FastifyReply, msg: string) => {
    const n = notWired(msg)
    reply.code(n.status).send(fail(config.errorCode, n.msg))
  }
  const guard = async (req: FastifyRequest, reply: FastifyReply) => (await requireAdmin(req, reply, deps)) !== undefined

  // ---- 总览 ----
  app.get('/admin/stats', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const s = stores.users?.stats() ?? { total: 0, active: 0, admin: 0, deleted: 0 }
    return ok({
      total_users: s.total,
      admin_count: s.admin,
      // 本 TS 部署还没有 VIP 角色语义（角色由管理员在「角色」页建）
      vip_count: 0,
      normal_count: Math.max(0, s.total - s.admin),
      today_new: 0,
      billing_dedupe: 0,
    })
  })

  // ---- 用户 ----
  app.get('/admin/users', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = req.query as Record<string, string>
    const page = clampPage(q['page'])
    const pageSize = clampPageSize(q['page_size'])
    const users = stores.users
    if (!users) return unavailable(reply, '用户存储未接')
    const { total, list } = users.list({
      page,
      pageSize,
      ...(q['keyword'] ? { keyword: q['keyword'] } : {}),
      ...(q['status'] ? { status: q['status'] } : {}),
      ...(q['role'] ? { role: q['role'] } : {}),
    })
    return ok({ total, page, page_size: pageSize, list })
  })

  app.get('/admin/users/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const user = stores.users?.byId(Number(id))
    if (!user) {
      reply.code(404).send(fail(config.errorCode, '用户不存在'))
      return
    }
    return ok(user)
  })

  app.post('/admin/users', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { username?: string; password?: string; nickname?: string; email?: string; role_codes?: string[]; plan_id?: number }
    if (!b.username || !b.password) {
      reply.code(400).send(fail(config.errorCode, '缺少用户名或密码'))
      return
    }
    if (!stores.users) return unavailable(reply, '用户存储未接')
    if (stores.users.byUsernameOrEmail(b.username)) {
      reply.code(400).send(fail(config.errorCode, '用户名或邮箱已被占用'))
      return
    }
    const created = stores.users.create({
      username: b.username,
      password: b.password,
      ...(b.nickname !== undefined ? { nickname: b.nickname } : {}),
      ...(b.email !== undefined ? { email: b.email } : {}),
      ...(b.role_codes ? { roles: b.role_codes } : {}),
      ...(b.plan_id !== undefined ? { planId: b.plan_id } : {}),
    })
    return ok(created)
  })

  app.patch('/admin/users/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { nickname?: string; email?: string; status?: number; plan_id?: number | null }
    const updated = stores.users?.update(Number(id), {
      ...(b.nickname !== undefined ? { nickname: b.nickname } : {}),
      ...(b.email !== undefined ? { email: b.email } : {}),
      ...(b.status !== undefined ? { status: b.status } : {}),
      ...(b.plan_id !== undefined ? { planId: b.plan_id } : {}),
    })
    if (!updated) {
      reply.code(404).send(fail(config.errorCode, '用户不存在'))
      return
    }
    return ok(updated)
  })

  app.delete('/admin/users/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const target = Number(id)
    if (target === 1) {
      reply.code(400).send(fail(config.errorCode, '内置管理员账号不允许删除'))
      return
    }
    stores.users?.softDelete(target)
    return ok({})
  })

  app.post('/admin/users/:id/restore', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    stores.users?.restore(Number(id))
    return ok({})
  })

  app.post('/admin/users/:id/roles', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { role_code?: string; role_codes?: string[]; replace?: boolean }
    const codes = b.role_codes ?? (b.role_code ? [b.role_code] : [])
    if (!stores.users) return unavailable(reply, '用户存储未接')
    if (b.replace) {
      stores.users.setRoles(Number(id), codes)
    } else {
      const cur = stores.users.byId(Number(id))?.roles.map((r) => r.code) ?? []
      stores.users.setRoles(Number(id), [...new Set([...cur, ...codes])])
    }
    return ok(stores.users.byId(Number(id)) ?? {})
  })

  app.post('/admin/users/:id/reset-password', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { new_password?: string }
    if (!b.new_password) {
      reply.code(400).send(fail(config.errorCode, '缺少新密码'))
      return
    }
    stores.users?.setPassword(Number(id), b.new_password)
    const target = stores.users?.byId(Number(id))
    if (target) stores.kv?.set(`admin_password_source:${target.username}`, 'panel')
    return ok({})
  })

  app.put('/admin/users/:id/plan', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { plan_id?: number | null }
    stores.quota?.setPlan(Number(id), b.plan_id ?? null)
    return ok(stores.users?.byId(Number(id)) ?? {})
  })

  app.get('/admin/users/:id/quota', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const user = stores.users?.byId(Number(id))
    if (!user) {
      reply.code(404).send(fail(config.errorCode, '用户不存在'))
      return
    }
    const q = stores.quota
    const since = q?.startOfWindow(user.id, config.tzOffsetHours) ?? new Date().toISOString()
    const limits = (q?.limitsOfPlan(user.plan_id ?? 0) ?? []).filter((l) => l.scope === 'source')
    const rows = limits.map((l) => {
      const used = q?.usedSince(user.id, l.target, since) ?? 0
      const override = q?.overridesOf(user.id).find((o) => o.target === l.target)
      return {
        source: l.target,
        limit: override ? override.limit : l.limit,
        plan_limit: l.limit,
        override: override ? override.limit : null,
        used,
        remaining: Math.max(0, (override ? override.limit : l.limit) - used),
      }
    })
    return ok({ user_id: user.id, plan: user.plan, since, rows })
  })

  app.put('/admin/users/:id/quota', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { overrides?: Array<{ source?: string; target?: string; limit?: number }> }
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    q.clearOverrides(Number(id))
    for (const o of b.overrides ?? []) {
      const target = o.source ?? o.target
      if (!target) continue
      q.setOverride(Number(id), 'source', target, o.limit ?? 0)
    }
    return ok({})
  })

  app.post('/admin/users/:id/refresh-quota', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    stores.quota?.refreshStart(Number(id))
    return ok({})
  })

  app.get('/admin/users/:id/quota-transfers', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const qs = req.query as Record<string, string>
    return ok(
      stores.quotaExtra?.transfers({ userId: Number(id), page: clampPage(qs['page']), pageSize: clampPageSize(qs['page_size']) }) ??
        { total: 0, page: 1, page_size: 20, list: [] },
    )
  })
  app.post('/admin/users/:id/quota-transfer', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { from?: string; to?: string; amount?: number }
    const extra = stores.quotaExtra
    if (!extra) return unavailable(reply, '额度转移存储未接')
    const target = stores.users?.byId(Number(id))
    const me = await resolveIdentity(req, config, deps.stores ?? {})
    try {
      const row = extra.transfer({
        userId: Number(id),
        username: target?.username ?? `#${id}`,
        operator: me.username ?? 'admin',
        from: b.from ?? '',
        to: b.to ?? '',
        amount: b.amount ?? 0,
        planId: target?.plan_id ?? null,
      })
      return ok(row)
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : '转移失败'))
    }
  })

  // ---- 角色 ----
  app.get('/admin/roles', async (req, reply) => {
    if (!(await guard(req, reply))) return
    return ok(stores.roles?.list() ?? [])
  })
  app.post('/admin/roles', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { code?: string; name?: string; description?: string }
    if (!b.code || !b.name) {
      reply.code(400).send(fail(config.errorCode, '缺少角色码或名称'))
      return
    }
    try {
      return ok(stores.roles?.create({ code: b.code, name: b.name, ...(b.description ? { description: b.description } : {}) }))
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : '创建失败'))
    }
  })
  app.patch('/admin/roles/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; description?: string }
    return ok(stores.roles?.update(Number(id), b) ?? {})
  })
  app.delete('/admin/roles/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    stores.roles?.remove(Number(id))
    return ok({})
  })

  // ---- 套餐（最小集：列表/增删改；限额与授权属额度域） ----
  app.get('/admin/quotas/plans', async (req, reply) => {
    if (!(await guard(req, reply))) return
    return ok(stores.plans?.list() ?? [])
  })
  app.post('/admin/quotas/plans', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { name?: string; code?: string; description?: string }
    if (!b.name) {
      reply.code(400).send(fail(config.errorCode, '缺少套餐名'))
      return
    }
    return ok(stores.plans?.create({ name: b.name, ...(b.code ? { code: b.code } : {}), ...(b.description ? { description: b.description } : {}) }))
  })
  app.patch('/admin/quotas/plans/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; description?: string; status?: number }
    return ok(stores.plans?.update(Number(id), b) ?? {})
  })
  app.delete('/admin/quotas/plans/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    stores.plans?.remove(Number(id))
    return ok({})
  })
  // 套餐限额（= 授权）：scope=source 的行就是"这个套餐能用哪些源"
  app.get('/admin/quotas/plans/:id/limits', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    const { id } = req.params as { id: string }
    return ok(q.limitsOfPlan(Number(id)))
  })
  app.get('/admin/quotas/plans/:id/data-sources', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    const { id } = req.params as { id: string }
    return ok(q.grantedSources(Number(id)))
  })
  app.post('/admin/quotas/limits', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    const b = (req.body ?? {}) as { plan_id?: number; scope?: string; target?: string; limit?: number }
    if (!b.plan_id || !b.scope || !b.target) {
      reply.code(400).send(fail(config.errorCode, '缺少 plan_id/scope/target'))
      return
    }
    const id = q.createLimit({ plan_id: b.plan_id, scope: b.scope, target: b.target, limit: b.limit ?? 0 })
    return ok({ id })
  })
  app.put('/admin/quotas/limits/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { limit?: number }
    stores.quota?.updateLimit(Number(id), b.limit ?? 0)
    return ok({})
  })
  app.delete('/admin/quotas/limits/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    stores.quota?.removeLimit(Number(id))
    return ok({})
  })
  // 批量授权 / 从别的套餐复制（面板的"一次给多个源"与"复制授权"）
  const grantMany = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await guard(req, reply))) return
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { source_names?: string[]; sources?: string[]; limit?: number }
    const names = b.source_names ?? b.sources ?? []
    for (const n of names) q.grant(Number(id), 'source', n, b.limit ?? 0)
    return ok({ granted: names.length })
  }
  app.post('/admin/quotas/plans/:id/sources', grantMany)
  app.post('/admin/quotas/plans/:id/data-sources', grantMany)
  app.post('/admin/quotas/plans/:id/data-sources/batch', grantMany)
  app.post('/admin/quotas/plans/:id/clone-sources', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { from_plan_id?: number; source_plan_id?: number; from?: number }
    const from = b.from_plan_id ?? b.source_plan_id ?? b.from
    if (!from) {
      reply.code(400).send(fail(config.errorCode, '缺少来源套餐 from_plan_id'))
      return
    }
    return ok({ cloned: q.cloneSources(Number(id), from) })
  })
  app.delete('/admin/quotas/plans/:id/data-sources/:ds_id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { ds_id } = req.params as { ds_id: string }
    stores.quota?.removeLimit(Number(ds_id))
    return ok({})
  })

  // ---- 设置 ----
  app.get('/admin/settings', async (req, reply) => {
    if (!(await guard(req, reply))) return
    // 形状与 Go 的 ListSettings 一致：**items**（不是 list）+ sensitive_keys；
    // 源声明位里的设置项带上 source/source_display，面板据此把它们归到各自的源卡片。
    const rows = stores.settings?.list() ?? []
    const declared = new Map<string, { code: string; display: string }>()
    for (const entry of deps.host?.registryRef.list() ?? []) {
      for (const decl of entry.meta.settings ?? []) declared.set(decl.key, { code: entry.code, display: entry.meta.display })
    }
    const items = rows.map((r) => {
      const src = declared.get(r.key)
      return {
        ...r,
        ...(src ? { source: src.code, source_display: src.display } : {}),
      }
    })
    return ok({ items, sensitive_keys: stores.settings?.sensitiveKeys() ?? [] })
  })
  app.post('/admin/settings', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { key?: string; value?: string; type?: string; description?: string; sensitive?: boolean }
    if (!b.key || !b.type) {
      reply.code(400).send(fail(config.errorCode, '缺少 key 或 type'))
      return
    }
    const settings = stores.settings as unknown as { upsertRaw?: (i: { key: string; value: string; type: string; description: string; sensitive?: boolean }) => void }
    if (!settings?.upsertRaw) return unavailable(reply, '设置存储未接')
    try {
      settings.upsertRaw({ key: b.key, value: b.value ?? '', type: b.type, description: b.description ?? '', sensitive: !!b.sensitive })
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : '写入失败'))
      return
    }
    return ok({})
  })
  app.put('/admin/settings/:key', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { key } = req.params as { key: string }
    const b = (req.body ?? {}) as { value?: string }
    try {
      stores.settings?.set(key, b.value ?? '')
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : '写入失败'))
      return
    }
    return ok({})
  })
  app.delete('/admin/settings/:key', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { key } = req.params as { key: string }
    const settings = stores.settings as unknown as { remove?: (k: string) => boolean }
    settings?.remove?.(key)
    return ok({})
  })

  // ---- 数据源 ----
  app.get('/admin/data-sources', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const ds = stores.dataSources as unknown as { listAll?: () => unknown[] }
    return ok(ds?.listAll?.() ?? [])
  })
  app.post('/admin/data-sources', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { name?: string; display_name?: string; category?: string; description?: string; sort_order?: number; status?: number }
    if (!b.name || !b.display_name) {
      reply.code(400).send(fail(config.errorCode, '缺少源码或显示名'))
      return
    }
    const ds = stores.dataSources as unknown as { create?: (i: never) => number }
    if (!ds?.create) return unavailable(reply, '数据源存储未接')
    return ok({ id: ds.create({ ...b, name: b.name, display_name: b.display_name } as never) })
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
    }
    const row = dsStore?.listAll?.().find((d) => d.id === Number(id))
    if (!row) {
      reply.code(404).send(fail(config.errorCode, '数据源不存在'))
      return
    }
    // 「限额即授权」：被套餐引用的源不能删，否则那一行限额会指向一个看不见的源
    if (stores.quota?.isSourceReferenced(row.name)) {
      reply.code(400).send(fail(config.errorCode, '该数据源被套餐引用，无法删除'))
      return
    }
    dsStore.remove?.(Number(id))
    // 顺手把它从公开榜放行名单里摘掉（源都没了，留着只会让名单越长越脏）
    try {
      setRankPublic(stores.settings, row.name, false)
    } catch {
      /* 设置存储不可用时不影响删除结果 */
    }
    return ok({})
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
    return ok(stores.sourceGroups?.list() ?? [])
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
    return ok(groups.create({ name: b.name, ...(b.sort_order !== undefined ? { sort_order: b.sort_order } : {}) }))
  })
  app.patch('/admin/source-groups/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; sort_order?: number; status?: number }
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

  // ---- 监控 ----
  app.get('/admin/monitor', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const logs = stores.callLogs as unknown as { stats?: () => unknown[] }
    return ok({ stats: logs?.stats?.() ?? [], total: stores.callLogs?.count() ?? 0 })
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

  app.get('/admin/monitor/subjects', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = req.query as Record<string, string>
    const logs = stores.callLogs as unknown as { subjects?: (dim: string, days: number) => unknown[] }
    const days = Math.max(1, Number(q['days'] ?? 7) || 7)
    return ok(logs?.subjects?.(q['dim'] ?? 'keyword', days) ?? [])
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

  // ---- 号池（packages/pool 的运行期快照；没有池时是空列表） ----
  app.get('/admin/pools', async (req, reply) => {
    if (!(await guard(req, reply))) return
    return ok(stores.pools?.statusAll() ?? [])
  })

  // ---- 公开榜（登录用户可读）：直接按明细聚合 ----
  app.get('/rank/boards', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const q = req.query as Record<string, string>
    const logs = stores.callLogs as unknown as { subjects?: (dim: string, days: number) => unknown[] }
    return ok({ dim: 'keyword', days: Number(q['days'] ?? 7), list: logs?.subjects?.('keyword', Number(q['days'] ?? 7)) ?? [] })
  })

  // ---- 用量流水与接口消耗 ----
  app.get('/admin/usage-logs', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    const qs = req.query as Record<string, string>
    return ok(
      q.usagePage({
        page: clampPage(qs['page']),
        pageSize: clampPageSize(qs['page_size']),
        ...(qs['username'] ? { username: qs['username'] } : {}),
        ...(qs['group'] ? { groupCode: qs['group'] } : {}),
      }),
    )
  })

  app.get('/admin/quota-costs', async (req, reply) => {
    if (!(await guard(req, reply))) return
    return ok((stores.quota?.costs() ?? []).map((c) => ({ ...c, group_code: c.group_code, interface: c.interface })))
  })
  // 套餐级接口限速：覆盖全局（面板「接口」页）
  app.get('/admin/quota-costs/plans', async (req, reply) => {
    if (!(await guard(req, reply))) return
    return ok(stores.quotaExtra?.costPlans() ?? [])
  })
  app.post('/admin/quota-costs/plans/upsert', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { plan_id?: number; group_code?: string; interface?: string; interval?: number; limit_count?: number; window_sec?: number }
    if (!b.plan_id || !b.group_code || !b.interface) {
      reply.code(400).send(fail(config.errorCode, '缺少 plan_id/group_code/interface'))
      return
    }
    const extra = stores.quotaExtra
    if (!extra) return unavailable(reply, '套餐级限速存储未接')
    extra.upsertCostPlan({
      plan_id: b.plan_id, group_code: b.group_code, interface: b.interface,
      interval: b.interval ?? 0, limit_count: b.limit_count ?? 0, window_sec: b.window_sec ?? 60,
    })
    return ok({})
  })
  app.put('/admin/quota-costs/plans/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { interval?: number; limit_count?: number; window_sec?: number }
    stores.quotaExtra?.updateCostPlan(Number(id), b)
    return ok({})
  })
  app.put('/admin/quota-costs/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { cost?: number; status?: number; interval?: number; limit_count?: number; window_sec?: number }
    stores.quota?.updateCost(Number(id), b)
    return ok({})
  })

  // ---- 我的额度（面板概览页）：形状照 Go 的 DashboardResponse 抄 ----
  app.get('/quota/dashboard', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const user = stores.users?.byId(id.userId)
    if (!user) {
      reply.code(404).send(fail(config.errorCode, '用户不存在'))
      return
    }
    const q = stores.quota
    const isAdmin = id.roles.includes('admin')
    const since = q?.startOfWindow(user.id, config.tzOffsetHours) ?? new Date().toISOString()
    const dayStart = q?.startOfWindow(0, config.tzOffsetHours) ?? since

    const groups = stores.sourceGroups?.sections() ?? []
    const rows = (deps.dataSources?.listEnabled() ?? []).filter((ds) => {
      if (isAdmin) return true
      // 非管理员只看见"套餐里有这一行"的源（限额即授权）
      return q ? q.effectiveLimit(user.id, user.plan_id, ds.name) !== -1 : false
    })

    const sources = rows.map((ds) => {
      const granted = q?.limitsOfPlan(user.plan_id ?? 0).find((l) => l.scope === 'source' && l.target === ds.name)
      const override = q?.overridesOf(user.id).find((o) => o.scope === 'source' && o.target === ds.name)
      const effective = isAdmin ? -1 : q?.effectiveLimit(user.id, user.plan_id, ds.name) ?? -1
      const used = isAdmin ? q?.usedTodayAll(ds.name, since) ?? 0 : q?.usedSince(user.id, ds.name, since) ?? 0
      const remaining = effective >= 0 ? Math.max(0, effective - used) : -1
      const usagePct = effective > 0 ? Math.min(100, Math.floor((used * 100) / effective)) : 0
      const entry = deps.host?.registryRef.get(ds.name)
      const actions = entry?.meta.actions ?? []
      return {
        id: ds.id ?? 0,
        source_code: ds.name,
        name: ds.display_name,
        group_id: ds.group_id ?? 0,
        group_name: groups.find((g) => g.id === (ds.group_id ?? 0))?.name ?? '',
        override: override ? (override.limit > 0 ? `+${override.limit}` : String(override.limit)) : '未设置',
        used_today: used,
        active_users: isAdmin ? q?.activeUsersForSource(ds.name, since) ?? 0 : 0,
        effective_total: effective,
        remaining,
        usage_pct: usagePct,
        next_reset: nextResetLabel(config.tzOffsetHours),
        handlers: actions,
        interfaces: actions.map((a) => {
          const c = q?.costOf(ds.name, a)
          return {
            id: c?.id ?? 0,
            name: a,
            cost: c?.cost ?? 0,
            interval: c?.interval ?? 0,
            limit_count: c?.limit_count ?? 0,
            window_sec: c?.window_sec ?? 60,
            enabled: (c?.status ?? 1) === 1,
          }
        }),
        ...(granted ? { plan_limit: granted.limit } : {}),
      }
    })

    return ok({
      sources,
      groups: groups.map((g) => ({ id: g.id, name: g.name, sort_order: g.sort_order, count: g.count })),
      ungrouped_count: sources.filter((s2) => (s2.group_id ?? 0) === 0).length,
      is_admin: isAdmin,
      plan_name: user.plan?.name ?? '',
      plan_code: user.plan?.code ?? '',
      plan_expire_at: null,
      active_users: isAdmin ? q?.activeUsersAll(since) ?? 0 : 0,
      call_count: isAdmin ? q?.callCountSince(dayStart) ?? 0 : 0,
      quota_cycle_mode: 'day',
      switch_allowed_at: null,
    })
  })

  app.post('/quota/transfer', async (req, reply) => {
    // 只认会话（长期密钥能读自己挪过什么，不能销毁/挪用额度）
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined || id.envKey) {
      reply.code(401).send(fail(401, '额度转移只认登录会话'))
      return
    }
    const b = (req.body ?? {}) as { from?: string; to?: string; amount?: number }
    const extra = stores.quotaExtra
    if (!extra) return unavailable(reply, '额度转移存储未接')
    const user = stores.users?.byId(id.userId)
    try {
      const row = extra.transfer({
        userId: id.userId,
        username: user?.username ?? '',
        operator: user?.username ?? '',
        from: b.from ?? '',
        to: b.to ?? '',
        amount: b.amount ?? 0,
        planId: user?.plan_id ?? null,
      })
      return ok(row)
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : '转移失败'))
    }
  })

  app.get('/quota/transfers', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const qs = req.query as Record<string, string>
    return ok(
      stores.quotaExtra?.transfers({ userId: id.userId, page: clampPage(qs['page']), pageSize: clampPageSize(qs['page_size']) }) ??
        { total: 0, page: 1, page_size: 20, list: [] },
    )
  })

  app.delete('/quota/transfers', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined || id.envKey) {
      reply.code(401).send(fail(401, '清除记录只认登录会话'))
      return
    }
    return ok({ cleared: stores.quotaExtra?.clearTransfers(id.userId) ?? 0 })
  })

  app.get('/quota/usage-logs', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const qs = req.query as Record<string, string>
    return ok(
      stores.quota?.usagePage({
        page: clampPage(qs['page']),
        pageSize: clampPageSize(qs['page_size']),
        userId: id.userId,
        ...(qs['group'] ? { groupCode: qs['group'] } : {}),
      }) ?? { total: 0, page: 1, page_size: 20, list: [] },
    )
  })

  // ---- 个人数据源地址 ----
  app.get('/user/source-configs', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const cfg = stores.sourceConfigs
    if (!cfg) return unavailable(reply, '数据源默认地址存储未接')
    const user = stores.users?.byId(id.userId)
    const isAdmin = id.roles.includes('admin')
    const mine = cfg.user(id.userId)
    const items = (deps.dataSources?.listEnabled() ?? [])
      .filter((ds) => isAdmin || (stores.quota ? stores.quota.effectiveLimit(id.userId!, user?.plan_id ?? null, ds.name) !== -1 : false))
      .map((ds) => ({ source_name: ds.name, source_display: ds.display_name, base_url: mine[ds.name] ?? '' }))
    return ok(items)
  })
  app.put('/user/source-configs', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const cfg = stores.sourceConfigs
    if (!cfg) return unavailable(reply, '数据源默认地址存储未接')
    const b = (req.body ?? {}) as { configs?: Array<{ source_name?: string; base_url?: string }> }
    for (const c of b.configs ?? []) {
      if (!c.source_name) continue
      cfg.setUser(id.userId, c.source_name, (c.base_url ?? '').trim())
    }
    return ok({})
  })

  // 导入入口：书源文件是否托管就位（就位才在面板显示提示；rc 路径与 Go 版同形）
  app.get('/user/import-config', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const rel = '/data/shuyuan/bookSource.json'
    const ready = existsSync(join(config.dataDir, 'shuyuan', 'bookSource.json'))
    return ok({ book_source_path: rel, ready })
  })

  // ---- 安全：登录限频读数与定向解锁（内存态，与 Go 同取舍） ----
  app.get('/admin/security/attempts', async (req, reply) => {
    if (!(await guard(req, reply))) return
    return ok(snapshot())
  })
  app.post('/admin/security/attempts/reset', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { ip?: string }
    return ok({ cleared: resetAttempts(b.ip) })
  })

  // ---- IP 黑名单（登录/注册/数据面三处共用一张表） ----
  app.get('/admin/blocked-ips', async (req, reply) => {
    if (!(await guard(req, reply))) return
    return ok(stores.blockedIPs?.list() ?? [])
  })
  app.post('/admin/blocked-ips', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { ip?: string; reason?: string }
    const ip = (b.ip ?? '').trim()
    if (!ip) {
      reply.code(400).send(fail(config.errorCode, '缺少 IP'))
      return
    }
    const blocked = stores.blockedIPs
    if (!blocked) return unavailable(reply, 'IP 黑名单存储未接')
    return ok(blocked.add(ip, b.reason ?? ''))
  })
  app.delete('/admin/blocked-ips/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    stores.blockedIPs?.remove(Number(id))
    return ok({})
  })

  // ---- 设备与密钥分布（读 sessions / api_keys / 明细 IP） ----
  app.get('/admin/devices', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const qs = req.query as Record<string, string>
    const page = clampPage(qs['page'])
    const pageSize = clampPageSize(qs['page_size'])
    const db = (stores.users as unknown as { db?: unknown })?.db as never
    void db
    const rows = stores.devices?.page({ page, pageSize, ...(qs['keyword'] ? { keyword: qs['keyword'] } : {}) })
    return ok(rows ?? { total: 0, page: 1, page_size: pageSize, list: [] })
  })

  // ---- 卡密（生成 / 作废 / 兑换） ----
  app.get('/admin/redeem-codes', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const qs = req.query as Record<string, string>
    return ok(
      stores.quotaExtra?.redeemCodes({
        page: clampPage(qs['page']),
        pageSize: clampPageSize(qs['page_size']),
        ...(qs['batch_no'] ? { batchNo: qs['batch_no'] } : {}),
        ...(qs['status'] ? { status: qs['status'] } : {}),
        ...(qs['plan_id'] ? { planId: Number(qs['plan_id']) } : {}),
      }) ?? { total: 0, page: 1, page_size: 20, list: [] },
    )
  })
  app.post('/admin/redeem-codes', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { count?: number; plan_id?: number; batch_no?: string }
    const plan = stores.plans?.byId(b.plan_id ?? 0)
    if (!plan) {
      reply.code(400).send(fail(config.errorCode, '套餐不存在'))
      return
    }
    const created = stores.quotaExtra?.createRedeemCodes({
      count: b.count ?? 1, planId: plan.id, planName: plan.name, ...(b.batch_no ? { batchNo: b.batch_no } : {}),
    })
    return ok(created ?? [])
  })
  app.post('/admin/redeem-codes/:id/revoke', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    return ok({ revoked: stores.quotaExtra?.revokeRedeemCode(Number(id)) ?? false })
  })
  app.post('/admin/redeem-codes/revoke-selected', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { ids?: number[] }
    return ok({ revoked: stores.quotaExtra?.revokeRedeemCodes(b.ids ?? []) ?? 0 })
  })
  app.delete('/admin/redeem-codes/batch/:batch_no', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { batch_no } = req.params as { batch_no: string }
    return ok({ revoked: stores.quotaExtra?.revokeRedeemBatch(batch_no) ?? 0 })
  })
  app.post('/user/redeem', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const b = (req.body ?? {}) as { code?: string }
    if (!b.code) {
      reply.code(400).send(fail(config.errorCode, '请输入卡密'))
      return
    }
    const user = stores.users?.byId(id.userId)
    try {
      const r = stores.quotaExtra?.redeem({ code: b.code, userId: id.userId, username: user?.username ?? '' })
      return ok({ plan: r?.plan ?? null })
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : '兑换失败'))
    }
  })

  // ---- 明确未接的域（面板有页、后端没有） ----
  const stubs: Array<[string, string, string]> = [
  ]
  for (const [method, path, what] of stubs) {
    const m = method.toLowerCase() as 'get' | 'post' | 'put' | 'delete'
    app[m](path, async (_req, reply) => unavailable(reply, what))
  }
}
