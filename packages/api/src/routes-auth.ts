// 登录、会话、个人资料与账号密钥（面板 Login/Profile 两页的入口）。
// 会话是**现行校验**：撤销之后旧票立刻失效（JWT 里带 jti，每次请求查 sessions 表）。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { fail, ok } from '@loomproxy/contract'
import type { Config } from '@loomproxy/kernel'
import { resolveIdentity, issueToken, tokenFromRequest, verifyToken } from './auth.ts'
import { lockedUntil, recordAttempt } from './login-limiter.ts'
import { notWired, type ApiStores } from './stores.ts'

type Deps = { config: Config; stores: ApiStores }

async function identityOf(req: FastifyRequest, deps: Deps) {
  return resolveIdentity(req, deps.config, {
    ...(deps.stores.sessions ? { sessions: deps.stores.sessions } : {}),
    ...(deps.stores.apiKeys ? { apiKeys: deps.stores.apiKeys } : {}),
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
    const roles = hit.user.roles.map((r) => r.code)
    const { token, expires_at, jti } = issueToken({ id: hit.user.id, username: hit.user.username, roles }, config)
    stores.sessions?.create(hit.user.id, jti, expires_at, req.ip, String(req.headers['user-agent'] ?? ''))
    users.touchLogin(hit.user.id)
    return ok({ token, expires_at, user: hit.user })
  })

  app.post('/auth/logout', async (req) => {
    const jti = jtiOf(req, config)
    if (jti) stores.sessions?.revoke(jti)
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

  app.post('/auth/register', async (_req, reply) => {
    reply.code(403).send(fail(config.errorCode, '本部署未开放注册：账号由管理员在「用户」页创建'))
  })
  app.post('/auth/forgot-password', async (_req, reply) => unavailable(reply, '找回密码（需邮件/短信通道）'))
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
