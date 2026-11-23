// 管理面 · 额度域：套餐、限额、用量、接口消耗、概览、转移、卡密。

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { fail, ok } from '@loomproxy/contract'
import { transferStatus } from '@loomproxy/store'
import { clampPage, clampPageSize } from '@loomproxy/kernel'
import { resolveIdentity } from '../auth.ts'
import { nextResetLabel, selfTransferView, transferResultView } from './shared.ts'
import type { AdminContext } from './shared.ts'

export function registerQuotaRoutes(app: FastifyInstance, deps: AdminContext): void {
  const { config, stores, guard, unavailable } = deps

  // ---- 套餐（最小集：列表/增删改；限额与授权属额度域） ----
  app.get('/admin/quotas/plans', async (req, reply) => {
    if (!(await guard(req, reply))) return
    // 面板一次就要每个套餐的「限额」与「已授权的数据源 id」：
    //   · Quotas 页按 p.limits 显示每档的行数与「源的 N 个」
    //   · Datasources 页按 p.data_source_ids 反查「套餐 N」
    // Go 那边是面板自己再查一遍；这里直接内联，少几趟请求（形状是超集，不改契约）
    const dsStore = deps.dataSources as unknown as { listAll?: () => Array<{ id: number; name: string }> }
    const idByName = new Map((dsStore?.listAll?.() ?? []).map((d) => [d.name, d.id]))
    const plans = (stores.plans?.list() ?? []).map((p) => {
      const limits = stores.quota?.limitsOfPlan(p.id) ?? []
      const ids = limits
        .filter((l) => l.scope === 'source')
        .map((l) => idByName.get(l.target))
        .filter((v): v is number => typeof v === 'number')
      return { ...p, limits, data_source_ids: ids }
    })
    return ok(plans)
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
    // 套餐与源名都要校验：**写进 quota_limits 的行就是授权**，一个 0 号套餐或拼错的源码
    // 会在库里留下一条"谁都看不见、却让数据源删不掉"的垃圾行（现场 2026-11-18）
    const planId = Number(id)
    if (!Number.isInteger(planId) || !stores.plans?.list().some((p) => p.id === planId)) {
      reply.code(404).send(fail(config.errorCode, '套餐不存在'))
      return
    }
    const names = b.source_names ?? b.sources ?? []
    const known = new Set((deps.dataSources as unknown as { listAll?(): Array<{ name: string }> })?.listAll?.().map((d) => d.name) ?? [])
    const unknown = names.filter((n) => !known.has(n))
    if (unknown.length > 0) {
      reply.code(400).send(fail(config.errorCode, `数据源不存在：${unknown.join(',')}`))
      return
    }
    const existing = new Set(q.grantedSources(planId).map((l) => l.target))
    let created = 0
    let skipped = 0
    for (const n of names) {
      // 已授权的跳过（面板提示"跳过已授权 N 个"），不覆盖它已有的限额
      if (existing.has(n)) {
        skipped++
        continue
      }
      q.grant(planId, 'source', n, b.limit ?? 0)
      created++
    }
    return ok({ created, skipped })
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
    const created = q.cloneSources(Number(id), from)
    return ok({ created, skipped: 0 })
  })
  app.delete('/admin/quotas/plans/:id/data-sources/:ds_id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { ds_id } = req.params as { ds_id: string }
    stores.quota?.removeLimit(Number(ds_id))
    return ok({})
  })

  // ---- 用量流水与接口消耗 ----
  app.get('/admin/usage-logs', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    const qs = req.query as Record<string, string>
    // 面板「用量流水」的数据源下拉读 source_codes（Go ListUsageLogs 同名字段）：
    // 列全部配置位（含停用源），不依赖流水里有没有记录——历史流水里可能有已停用源的消耗。
    // source_display_names 是 TS 附加的显示名映射（Go 面板直接用 code，这里为了可读性给中文名）。
    const allSources = deps.dataSources?.listAll() ?? []
    const sourceCodes = allSources.map((d) => d.name)
    const sourceDisplayNames = Object.fromEntries(allSources.map((d) => [d.name, d.display_name || d.name]))
    return ok({
      ...q.usagePage({
        page: clampPage(qs['page']),
        pageSize: clampPageSize(qs['page_size']),
        ...(qs['username'] ? { username: qs['username'] } : {}),
        ...(qs['group'] ? { groupCode: qs['group'] } : {}),
      }),
      source_codes: sourceCodes,
      source_display_names: sourceDisplayNames,
    })
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
      // 非管理员只看见"套餐里有这一行"的源（限额即授权）。
      // 注意判据是**有没有行**，不是额度值：额度填 -1（不限）仍然算授权过。
      return q ? q.hasGrant(user.plan_id, ds.name) : false
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
        userId: id.userId, operatorId: id.userId, via: 'self',
        from: b.from ?? '', to: b.to ?? '', amount: b.amount ?? 0,
        planId: user?.plan_id ?? null,
      })
      return ok(transferResultView(row))
    } catch (e) {
      const status = transferStatus(e)
      reply.code(status).send(fail(config.errorCode, status === 500 ? '转移失败' : (e as Error).message))
    }
  })

  app.get('/quota/transfers', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const qs = req.query as Record<string, string>
    const data = stores.quotaExtra?.transfers({ userId: id.userId, page: clampPage(qs['page']), pageSize: clampPageSize(qs['page_size']) })
    return ok({
      ...(data ?? { total: 0, page: 1, page_size: 20 }),
      list: (data?.list ?? []).map(selfTransferView),
      scope: '转移改的是日限额的覆盖增量，**不随每日刷新回退**；要恢复只能再转回来',
    })
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
}
