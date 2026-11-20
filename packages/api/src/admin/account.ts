// 管理面 · 账号域：总览、用户、角色、安全限频、IP 黑名单、设备。

import type { FastifyInstance } from 'fastify'
import { fail, ok, normalizeUsername, validUsername } from '@loomproxy/contract'
import { clampPage, clampPageSize, createClock } from '@loomproxy/kernel'
import { resolveIdentity } from '../auth.ts'
import { resetAttempts, snapshot } from '../login-limiter.ts'
import { dedupeReadout } from '../dispatch.ts'
import { Ledger } from '@loomproxy/gate'
import type { AdminContext } from './shared.ts'

export function registerAccountRoutes(app: FastifyInstance, deps: AdminContext): void {
  const { config, stores, guard, unavailable } = deps

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
}
