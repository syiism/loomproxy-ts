// 管理面 · 账号域：总览、用户、角色、安全限频、IP 黑名单、设备。

import type { FastifyInstance } from 'fastify'
import { fail, ok, normalizeUsername, validUsername } from '@loomproxy/contract'
import { clampPage, clampPageSize, createClock } from '@loomproxy/kernel'
import { resolveIdentity } from '../auth.ts'
import { resetAttempts, snapshot } from '../login-limiter.ts'
import { dedupeReadout } from '../dispatch.ts'
import { Ledger } from '@loomproxy/gate'
import { transferStatus } from '@loomproxy/store'
import { adminTransferView, transferResultView } from './shared.ts'
import type { AdminContext } from './shared.ts'

export function registerAccountRoutes(app: FastifyInstance, deps: AdminContext): void {
  const { config, stores, guard, unavailable } = deps

  // ---- 总览 ----
  app.get('/admin/stats', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const s = stores.users?.stats() ?? { total: 0, active: 0, admin: 0, vip: 0, deleted: 0 }
    return ok({
      total_users: s.total,
      admin_count: s.admin,
      // VIP 是角色码 'vip'（与 Go 的 Stats 同口径，不是套餐码），角色从库里读
      vip_count: s.vip,
      normal_count: Math.max(0, s.total - s.admin - s.vip),
      // 今日新增：今日 0 点（平台时区，kernel/clock 单一事实源）起创建的用户数
      today_new: (stores.users as unknown as { todayNew?: (since: string) => number })?.todayNew?.(
        new Date(createClock(config.tzOffsetHours).startOfDay()).toISOString(),
      ) ?? 0,
      // 扣减冷却的真实读数：enabled 取配置（BILLING_DEDUPE_SEC），挡/在记取运行时内存态
      billing_dedupe: dedupeReadout(deps.ledger ?? new Ledger(), config.billingDedupeSec > 0),
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
    if (!normalizeUsername(b.username) || !validUsername(normalizeUsername(b.username))) {
      reply.code(400).send(fail(config.errorCode, '用户名长度需为 1–16 个字符'))
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
    // 形状照 Go GetUserQuota：面板（原样搬来的 web/）读 items/plan_name/usage_since，
    // 少一格整张表就是空的（WORKLOG §6 的形状错位家族）。
    const since = q?.startOfWindow(user.id, config.tzOffsetHours) ?? new Date().toISOString()
    const plan = user.plan ?? stores.plans?.list().find((p) => p.code === 'free')
    const planId = user.plan?.id ?? plan?.id ?? 0
    const planLimits = new Map(
      (q?.limitsOfPlan(planId) ?? []).filter((l) => l.scope === 'source').map((l) => [l.target, l.limit]),
    )
    const overrides = new Map(
      (q?.overridesOf(user.id) ?? []).filter((o) => o.limit !== 0).map((o) => [o.target, o.limit]),
    )
    const sourceRows = (deps.dataSources as { listAll?(): unknown[] } | undefined)?.listAll?.() ?? deps.dataSources?.listEnabled() ?? []
    const items = (sourceRows as Array<{ name: string; display_name: string; category: string }>)
      .map((ds) => {
        const granted = planLimits.has(ds.name)
        const planLimit = granted ? planLimits.get(ds.name)! : null
        const userLimit = overrides.has(ds.name) ? overrides.get(ds.name)! : null
        return {
          source_code: ds.name,
          source_name: ds.display_name,
          category: ds.category,
          granted,
          plan_limit: planLimit,
          used: q?.usedSince(user.id, ds.name, since) ?? 0,
          user_limit: userLimit,
          // 未授权的源给 -1，面板按 granted=false 显示「无权限」，不能让它被读成「不限」
          effective: !granted ? -1 : q?.effectiveLimit(user.id, planId, ds.name) ?? -1,
        }
      })
      .sort((a, b) => a.category.localeCompare(b.category) || a.source_name.localeCompare(b.source_name))
    return ok({
      user_id: user.id,
      username: user.username,
      plan_name: plan?.name ?? '',
      plan_code: plan?.code ?? '',
      plan_alias: '', // 业务别名表未随仓库迁移；面板只在非空时显示
      quota_reset_at: q?.resetAt(user.id) ?? null,
      usage_since: since,
      items,
    })
  })

  app.put('/admin/users/:id/quota', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { overrides?: Array<{ group_code?: string; limit?: number }> }
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    if (!Array.isArray(b.overrides)) {
      reply.code(400).send(fail(config.errorCode, '缺少 overrides'))
      return
    }
    // 与 Go UpdateUserQuota 同口径：只改这次提交的源，**不清空其它覆盖**；limit=0 删行
    for (const o of b.overrides) {
      const target = String(o.group_code ?? '').trim()
      if (!target) continue
      q.setOverride(Number(id), 'source', target, Math.trunc(Number(o.limit ?? 0)))
    }
    return ok({ message: '额度覆盖已更新' })
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
    const data = stores.quotaExtra?.transfers({ userId: Number(id), page: clampPage(qs['page']), pageSize: clampPageSize(qs['page_size']), includeCleared: true })
    return ok({
      ...(data ?? { total: 0, page: 1, page_size: 20 }),
      list: (data?.list ?? []).map((r) => adminTransferView(r, stores.users?.byId(r.operator_id)?.username ?? '')),
    })
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
        userId: Number(id), operatorId: me.userId ?? 0, via: 'admin',
        from: b.from ?? '', to: b.to ?? '', amount: b.amount ?? 0,
        planId: target?.plan_id ?? null,
      })
      return ok(transferResultView(row, target ? { id: target.id, username: target.username } : undefined))
    } catch (e) {
      const status = transferStatus(e)
      reply.code(status).send(fail(config.errorCode, status === 500 ? '转移失败' : (e as Error).message))
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
    // 统计窗口起点与标红阈值来自设置项（与 Go 的 device_watch 同口径）
    const windowDays = stores.settings?.getInt('device_watch_window_days', 7) ?? 7
    const suspectIps = stores.settings?.getInt('suspect_distinct_ips', 8) ?? 8
    const windowStartIso = new Date(Date.now() - Math.max(1, windowDays) * 86_400_000).toISOString()
    const rows = stores.devices?.page({
      page, pageSize,
      ...(qs['keyword'] ? { keyword: qs['keyword'] } : {}),
      ...(qs['sort'] ? { sort: qs['sort'] } : {}),
      ...(qs['dir'] ? { dir: qs['dir'] } : {}),
      windowStartIso,
      suspectIps,
    })
    if (!rows) return ok({ total: 0, page: 1, page_size: pageSize, list: [], sort: 'sessions', dir: 'desc' })
    return ok({
      ...rows,
      // 口径随读数下发：面板上"N 个 IP 算不算异常"取决于当时的阈值与开关
      config: {
        device_watch_enabled: stores.settings?.getBool('device_watch_enabled', false),
        max_active_sessions: stores.settings?.getInt('max_active_sessions', 5),
        suspect_distinct_ips: suspectIps,
        window_days: windowDays,
      },
    })
  })
}
