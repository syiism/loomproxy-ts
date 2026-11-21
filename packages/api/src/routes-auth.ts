// 登录、会话、个人资料与账号密钥（面板 Login/Profile 两页的入口）。
// 会话是**现行校验**：撤销之后旧票立刻失效（JWT 里带 jti，每次请求查 sessions 表）。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { fail, ok, normalizeUsername, validUsername } from '@loomproxy/contract'
import type { Config } from '@loomproxy/kernel'
import { authCookie, clearAuthCookie, resolveIdentity, issueToken, tokenFromRequest, verifyToken } from './auth.ts'
import { lockedUntil, recordAttempt } from './login-limiter.ts'
import { createClock } from '@loomproxy/kernel'
import { Check, Consume, sceneEnabledFor, VERIFY_ERR, type VerifyDeps } from './verify.ts'
import { notWired, type ApiStores } from './stores.ts'

type Deps = { config: Config; stores: ApiStores }

/** 验证码校验依赖：settings/store 缺任一则无法校验（场景启用时应视为失败关闭） */
function verifyDeps(deps: Deps): VerifyDeps | undefined {
  const settings = deps.stores.settings, store = deps.stores.verification
  if (!settings || !store) return undefined
  return {
    settings,
    store,
    dayStartIso: new Date(createClock(deps.config.tzOffsetHours).startOfDay()).toISOString(),
  }
}

/** 场景启用时校验验证码，返回可消费的行 id；未启用返回 undefined（不校验） */
function checkVerify(
  deps: Deps, scene: string, target: string, code: string | undefined,
): { id: number } | { error: string } | undefined {
  const settings = deps.stores.settings
  if (!settings || !sceneEnabledFor(settings, scene)) return undefined // 场景未启用：不校验
  const vd = verifyDeps(deps)
  if (!vd) return { error: '请先获取验证码' } // 场景启用但存储未接：失败关闭
  try {
    return { id: Check(scene, target, code ?? '', vd) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : VERIFY_ERR.notFound().message }
  }
}

async function identityOf(req: FastifyRequest, deps: Deps) {
  return resolveIdentity(req, deps.config, {
    ...(deps.stores.sessions ? { sessions: deps.stores.sessions } : {}),
    ...(deps.stores.apiKeys ? { apiKeys: deps.stores.apiKeys } : {}),
    ...(deps.stores.users ? { users: deps.stores.users } : {}),
  })
}

async function requireUser(req: FastifyRequest, reply: FastifyReply, deps: Deps) {
  const id = await identityOf(req, deps)
  if (id.userId === undefined) {
    reply.code(401).send(fail(401, '请先登录'))
    return undefined
  }
  const view = deps.stores.users?.byId(id.userId)
  if (!view) {
    reply.code(401).send(fail(401, '账号不存在或已停用'))
    return undefined
  }
  return { id, view }
}

function jtiOf(req: FastifyRequest, cfg: Config): string | undefined {
  const token = tokenFromRequest(req)
  if (!token) return undefined
  return verifyToken(token, cfg.jwtSecret)?.jti
}

/**
 * 邮箱域名名单：与 Go 的 seed 说明同义——后缀匹配（example.com 命中 mail.example.com）、
 * 白名单非空时先过白名单，再过黑名单。留空=不限制。
 */
function emailAllowed(email: string, settings?: { get(key: string): string }): boolean {
  const domain = email.split('@')[1] ?? ''
  if (!domain) return false
  const norm = (raw: string): string[] =>
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  const hit = (list: string[]) => list.some((d) => domain === d || domain.endsWith(`.${d}`))
  const allow = norm(settings?.get('email_domain_allowlist') ?? '')
  if (allow.length > 0 && !hit(allow)) return false
  const block = norm(settings?.get('email_domain_blocklist') ?? '')
  return !(block.length > 0 && hit(block))
}

export function registerAuthRoutes(app: FastifyInstance, deps: Deps): void {
  const { config, stores } = deps
  const unavailable = (reply: FastifyReply, msg: string) => {
    const n = notWired(msg)
    reply.code(n.status).send(fail(config.errorCode, n.msg))
  }

  app.post('/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string; email?: string }
    const login = (body.username ?? body.email ?? '').trim()
    if (!login || !body.password) {
      reply.code(400).send(fail(config.errorCode, '请输入用户名与密码'))
      return
    }
    // 三处共用一个判定口：黑名单（长期）→ 限频（短时爆破）
    if (stores.blockedIPs?.isBlocked(req.ip)) {
      reply.code(403).send(fail(config.errorCode, '你的 IP 已被拉黑，请联系管理员'))
      return
    }
    const until = lockedUntil(req.ip)
    if (until > 0) {
      reply.code(429).send(fail(config.errorCode, `尝试过于频繁，请 ${new Date(until).toISOString().slice(11, 16)} 后再试`))
      return
    }
    const users = stores.users
    if (!users) return unavailable(reply, '账号存储未接')
    const hit = users.verifyWithLogin(login, body.password)
    recordAttempt(req.ip, login, !!hit && hit.row.status === 1)
    if (!hit) {
      reply.code(401).send(fail(config.errorCode, '用户名或密码错误'))
      return
    }
    if (hit.row.status !== 1) {
      reply.code(403).send(fail(config.errorCode, '账号已被禁用'))
      return
    }
    // 角色不写进 token（Go 版同口径）：每次请求从库里读，改完立刻生效。
    // 有效期：设置项 jwt_expire_hours 覆盖环境变量（-1 = 永不过期，Go 的同一条语义）
    const hours = stores.settings?.getInt('jwt_expire_hours', config.jwtExpireHours) ?? config.jwtExpireHours
    const effectiveHours = hours === 0 ? config.jwtExpireHours : hours
    const { token, expires_at, jti } = issueToken(
      { id: hit.user.id, username: hit.user.username },
      { ...config, jwtExpireHours: effectiveHours },
    )
    stores.sessions?.create(hit.user.id, jti, expires_at, req.ip, String(req.headers['user-agent'] ?? ''))
    // 多设备监控：登录之后收一次口子——活跃会话超上限就踢掉最旧的（保留本次 + 最近 N-1 个）。
    // 开关关闭时不处置（与 Go 同口径）；IP 数不参与处置，只看活跃会话数。
    if (stores.settings?.getBool('device_watch_enabled', false)) {
      const maxKeep = stores.settings.getInt('max_active_sessions', 5)
      const removed = stores.sessions?.revokeExcess(hit.user.id, jti, maxKeep) ?? 0
      if (removed > 0) console.error(`[auth] 多设备监控自动移出会话 user_id=${hit.user.id} 移出=${removed} 保留=${maxKeep}`)
    }
    users.touchLogin(hit.user.id)
    // 与 Go utils.SetTokenCookie 同口径：登录时把同一枚 JWT 写成 HttpOnly Cookie，
    // 否则浏览器里旧的 Go Cookie 不会刷新，下一次数据面请求会拿失效 jti 撞 401。
    reply.header('set-cookie', authCookie(token, effectiveHours))
    return ok({ token, expires_at, user: hit.user })
  })

  app.post('/auth/logout', async (req, reply) => {
    const jti = jtiOf(req, config)
    if (jti) stores.sessions?.revoke(jti)
    reply.header('set-cookie', clearAuthCookie())
    return ok({})
  })

  app.get('/auth/me', async (req, reply) => {
    const me = await requireUser(req, reply, deps)
    if (!me) return
    return ok(me.view)
  })

  app.patch('/auth/me', async (req, reply) => {
    const me = await requireUser(req, reply, deps)
    if (!me) return
    const body = (req.body ?? {}) as { nickname?: string; email?: string }
    const updated = stores.users?.update(me.id.userId!, {
      ...(body.nickname !== undefined ? { nickname: body.nickname } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
    })
    return ok(updated ?? me.view)
  })

  app.post('/auth/password', async (req, reply) => {
    const me = await requireUser(req, reply, deps)
    if (!me) return
    const body = (req.body ?? {}) as { old_password?: string; new_password?: string }
    if (!body.old_password || !body.new_password) {
      reply.code(400).send(fail(config.errorCode, '缺少原密码或新密码'))
      return
    }
    if (!stores.users?.verify(me.view.username, body.old_password)) {
      reply.code(400).send(fail(config.errorCode, '原密码不正确'))
      return
    }
    stores.users.setPassword(me.id.userId!, body.new_password)
    // 面板上改过 → 标记 panel：重启时不再用 env 的口令覆盖（除非 ADMIN_PASSWORD_SYNC=true）
    stores.kv?.set(`admin_password_source:${me.view.username}`, 'panel')
    // 改密后把其它会话踢掉（本会话保留，避免"改完密码自己被登出"）
    const jti = jtiOf(req, config)
    if (jti) stores.sessions?.revokeOthers(me.id.userId!, jti)
    return ok({})
  })

  app.post('/auth/privacy', async (req, reply) => {
    const me = await requireUser(req, reply, deps)
    if (!me) return
    const body = (req.body ?? {}) as { content_consent?: boolean }
    stores.users?.setConsent(me.id.userId!, body.content_consent !== false)
    return ok({})
  })

  app.get('/auth/sessions', async (req, reply) => {
    const me = await requireUser(req, reply, deps)
    if (!me) return
    const cur = jtiOf(req, config)
    const list = (stores.sessions?.listByUser(me.id.userId!) ?? []).map((s) => ({
      id: s.id,
      ip: s.ip,
      user_agent: s.user_agent,
      created_at: s.created_at,
      expires_at: s.expires_at,
      current: s.jti === cur,
    }))
    return ok(list)
  })

  app.delete('/auth/sessions/:id', async (req, reply) => {
    const me = await requireUser(req, reply, deps)
    if (!me) return
    const { id } = req.params as { id: string }
    const row = (stores.sessions?.listByUser(me.id.userId!) ?? []).find((s) => String(s.id) === id)
    if (!row) {
      reply.code(404).send(fail(config.errorCode, '会话不存在'))
      return
    }
    stores.sessions?.revoke(row.jti)
    return ok({})
  })

  app.post('/auth/sessions/revoke-others', async (req, reply) => {
    const me = await requireUser(req, reply, deps)
    if (!me) return
    const cur = jtiOf(req, config) ?? ''
    const n = stores.sessions?.revokeOthers(me.id.userId!, cur) ?? 0
    return ok({ revoked: n })
  })

  app.post('/auth/register', async (req, reply) => {
    const settings = stores.settings
    const users = stores.users
    if (!users) return unavailable(reply, '账号存储未接')
    // 开关：register_enabled=false ⇒ 关闭注册（默认 true，与 Go 的 seed 一致）
    if (settings && !settings.getBool('register_enabled', true)) {
      reply.code(403).send(fail(config.errorCode, '注册已关闭：账号由管理员在「用户」页创建'))
      return
    }
    const b = (req.body ?? {}) as { username?: string; password?: string; email?: string; nickname?: string; verification_code?: string }
    const username = normalizeUsername(b.username ?? '')
    const email = (b.email ?? '').trim().toLowerCase()
    if (!username || !b.password) {
      reply.code(400).send(fail(config.errorCode, '缺少用户名或密码'))
      return
    }
    if (!validUsername(username)) {
      reply.code(400).send(fail(config.errorCode, '用户名长度需为 1–16 个字符'))
      return
    }
    if (email && !emailAllowed(email, settings)) {
      reply.code(400).send(fail(config.errorCode, '该邮箱域名不允许注册'))
      return
    }
    // 邮箱域名闸之后校验验证码（被拒的域名不必先烧码）；Check 不消费，注册成功后才 Consume
    const vc = email ? checkVerify(deps, 'register', email, b.verification_code) : undefined
    if (vc && 'error' in vc) {
      reply.code(400).send(fail(config.errorCode, vc.error))
      return
    }
    if (users.byUsernameOrEmail(username) || (email && users.byUsernameOrEmail(email))) {
      reply.code(400).send(fail(config.errorCode, '用户名或邮箱已被占用'))
      return
    }
    // 默认角色 / 默认套餐：都来自设置项（填的 code 不存在就回退到 user / 免费版）
    const roleCode = (settings?.get('default_role') ?? 'user').trim() || 'user'
    const planCode = (settings?.get('default_quota_plan') ?? 'free').trim() || 'free'
    const plan = stores.plans?.list().find((p) => p.code === planCode) ?? stores.plans?.list()[0]
    const roles = roleCode === 'admin' ? ['user'] : [roleCode] // 注册入口不允许自封管理员
    let created
    try {
      created = users.create({
        username,
        password: b.password,
        ...(b.nickname ? { nickname: b.nickname } : {}),
        ...(email ? { email } : {}),
        ...(plan ? { planId: plan.id } : {}),
        roles,
      })
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : '注册失败'))
      return
    }
    // 注册成功后消费验证码；并发被占用则注册仍算成功（与 Go 同口径）
    if (vc && 'id' in vc) {
      const vd = verifyDeps(deps)
      if (vd && !Consume(vc.id, vd)) console.error(`[verify] 注册验证码消费失败（可能并发复用）row_id=${vc.id}`)
    }
    // 面板注册后直接 setToken(data.token) —— 与登录同形状
    const { token, expires_at, jti } = issueToken({ id: created.id, username: created.username }, config)
    stores.sessions?.create(created.id, jti, expires_at, req.ip, String(req.headers['user-agent'] ?? ''))
    return ok({ token, expires_at, user: created })
  })
  app.post('/auth/forgot-password', async (req, reply) => {
    const settings = stores.settings
    const users = stores.users
    if (!users) return unavailable(reply, '账号存储未接')
    const b = (req.body ?? {}) as {
      username?: string; email?: string; new_password?: string; verification_code?: string
    }
    const username = (b.username ?? '').trim().toLowerCase()
    const email = (b.email ?? '').trim().toLowerCase()
    if (!username || !email || !b.new_password) {
      reply.code(400).send(fail(config.errorCode, '缺少用户名、邮箱或新密码'))
      return
    }
    // 账号匹配在前：不存在/邮箱不符统一回同一句，验证码不被无谓消耗（与 Go 同口径）
    const row = users.byUsernameOrEmail(username)
    if (!row || row.email !== email) {
      reply.code(400).send(fail(config.errorCode, '用户名与邮箱不匹配'))
      return
    }
    if (row.status !== 1) {
      reply.code(403).send(fail(config.errorCode, '账号已被禁用'))
      return
    }
    const vc = checkVerify(deps, 'forgot_password', email, b.verification_code)
    if (vc && 'error' in vc) {
      reply.code(400).send(fail(config.errorCode, vc.error))
      return
    }
    users.setPassword(row.id, b.new_password)
    // 旧密码可能泄露：吊销全部旧会话（与 Go 同口径）
    stores.sessions?.revokeOthers(row.id, '')
    if (vc && 'id' in vc) {
      const vd = verifyDeps(deps)
      if (vd) Consume(vc.id, vd)
    }
    // 找回后自动登录（与 Go 一致）
    const u = users.byId(row.id)
    if (!u) return unavailable(reply, '账号存储未接')
    const { token, expires_at, jti } = issueToken({ id: u.id, username: u.username }, config)
    stores.sessions?.create(u.id, jti, expires_at, req.ip, String(req.headers['user-agent'] ?? ''))
    return ok({ token, expires_at, user: u })
  })
  app.post('/auth/quota-cycle', async (_req, reply) => unavailable(reply, '额度周期切换（属额度域）'))
  app.put('/auth/display-alias', async (_req, reply) => unavailable(reply, '套餐/角色显示别名'))

  // ---- 账号密钥（面板复制/撤销） ----
  app.get('/apikey', async (req, reply) => {
    const me = await requireUser(req, reply, deps)
    if (!me) return
    return ok(stores.apiKeys?.listByUser(me.id.userId!) ?? [])
  })

  app.post('/apikey', async (req, reply) => {
    const me = await requireUser(req, reply, deps)
    if (!me) return
    const body = (req.body ?? {}) as { name?: string }
    const name = (body.name ?? '').trim()
    if (!name) {
      reply.code(400).send(fail(config.errorCode, '请输入密钥名称'))
      return
    }
    const key = 'lp_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    return ok(stores.apiKeys?.create(me.id.userId!, name, key))
  })

  app.delete('/apikey/:id', async (req, reply) => {
    const me = await requireUser(req, reply, deps)
    if (!me) return
    const { id } = req.params as { id: string }
    const done = stores.apiKeys?.revoke(me.id.userId!, Number(id)) ?? false
    if (!done) {
      reply.code(404).send(fail(config.errorCode, '密钥不存在'))
      return
    }
    return ok({})
  })
}
