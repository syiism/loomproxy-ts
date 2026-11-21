// 鉴权四形态（迁移-TS-1 §3）：Bearer / ?token= / Cookie / API Key。
// JWT 用 HMAC-SHA256 校验（与 Go 版同算法）；会话/密钥表落库属于 store 的后续工作，
// 当前环境静态键（API_KEYS）可用，账号级密钥与用户会话留待 store 接入。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Config } from '@loomproxy/kernel'

export type Identity = {
  userId?: number
  username?: string
  roles: string[]
  /** env 静态键是匿名凭证：不算归属账号（控制面必须拒绝） */
  envKey: boolean
}

export const ANONYMOUS: Identity = { roles: [], envKey: false }

/**
 * JWT claims：**与 Go 版 utils/jwt.go 的 JWTClaims 同形**（uid/username + RegisteredClaims）。
 * Go 侧只用 `uid`，从不把角色写进 token —— 角色每次从库里读，权限变更立刻生效、不用重新登录。
 * `user_id`/`roles` 是本仓早期形状，读的时候继续兜着（不然旧票会一夜之间全失效）。
 */
type Claims = {
  uid?: number
  user_id?: number
  username?: string
  roles?: string[]
  exp?: number
  jti?: string
  iss?: string
  sub?: string
  iat?: number
}

/** 登录态 Cookie 名：与 Go 版 utils/jwt.go 的 TokenCookieName 同一个字面量（互认） */
export const TOKEN_COOKIE = 'loomproxy_token'

/**
 * Go utils.SetTokenCookie 的同口径 Cookie：HttpOnly + Lax + Path=/。
 * -1（永不过期）落 10 年，<=0 回退 7 天。TS 之前只在 JSON 里回 token、不下发 Cookie，
 * 浏览器里残留的 Go 版 Cookie 就再也不会被刷新，过期/被挤掉后只能拿到 401。
 */
export function authCookie(token: string, expireHours: number): string {
  const maxAge = expireHours === -1 ? 10 * 365 * 24 * 3600 : expireHours > 0 ? expireHours * 3600 : 7 * 24 * 3600
  return `${TOKEN_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`
}

export function clearAuthCookie(): string {
  return `${TOKEN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
}

/** 身份解析需要的存储（会话吊销要现行查库：撤销之后旧票必须立刻失效） */
export type IdentityDeps = {
  sessions?: { isActive(jti: string): boolean; exists?(jti: string): boolean }
  apiKeys?: { ownerOf(key: string): { user_id: number } | undefined }
  /** 角色来源：token 里不带角色，每次从库里读（Go 版同口径） */
  users?: { byId(id: number): { username: string; roles: Array<{ code: string }> } | undefined }
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url')
}

export function signToken(claims: Claims, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify(claims))
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

export function verifyToken(token: string, secret: string): Claims | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const [header, payload, sig] = parts as [string, string, string]
  const expect = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expect)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined
  let claims: Claims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims
  } catch {
    return undefined
  }
  if (claims.exp && claims.exp * 1000 < Date.now()) return undefined
  return claims
}

export function tokenFromRequest(req: FastifyRequest): string {
  const auth = req.headers.authorization
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7)
  const q = req.query as Record<string, unknown>
  if (typeof q['token'] === 'string' && q['token']) return q['token']
  const cookie = req.headers.cookie
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [k, ...rest] = part.trim().split('=')
      // Go 版的 Cookie 名与早期本仓的名字都认：迁移期两边同时在线是常态
      if (k === TOKEN_COOKIE || k === 'loomproxy_token') return rest.join('=')
    }
  }
  return ''
}

export function apiKeyFromRequest(req: FastifyRequest): string {
  const h = req.headers['x-api-key']
  if (typeof h === 'string' && h) return h
  const q = req.query as Record<string, unknown>
  if (typeof q['api_key'] === 'string' && q['api_key']) return q['api_key']
  return ''
}

/**
 * 尽力解析（对应 VerifyAuth）：解析不出来就是匿名，不在此处拒绝。
 * 传了 IdentityDeps 时多两道现行校验：会话被撤销/账号被禁用 → 票作废；账号 API Key 认出归属用户。
 */
export async function resolveIdentity(req: FastifyRequest, cfg: Config, deps: IdentityDeps = {}): Promise<Identity> {
  const token = tokenFromRequest(req)
  if (token) {
    const claims = verifyToken(token, cfg.jwtSecret)
    if (claims) {
      // 票的归属：本库有这张 jti 就必须有效（撤销/禁用立即失效）；
      // 本库没有（跨版本/跨库签发，例如同一套 JWT_SECRET 下的 Go 旧票）按"外来票"放行——签名本身仍是权威。
      const known = claims.jti !== undefined && deps.sessions?.exists !== undefined ? deps.sessions.exists(claims.jti) : true
      const revoked =
        claims.jti !== undefined &&
        deps.sessions !== undefined &&
        (known ? !deps.sessions.isActive(claims.jti) : false)
      const uid = claims.uid ?? claims.user_id
      if (!revoked) {
        // 角色优先读库（Go 版 token 里根本没有 roles）；库不可用时才退回 token 里的旧字段
        const fromDb = uid !== undefined ? deps.users?.byId(uid) : undefined
        const roles = fromDb ? fromDb.roles.map((r) => r.code) : claims.roles ?? []
        return {
          ...(uid !== undefined ? { userId: uid } : {}),
          ...(fromDb?.username ?? claims.username ? { username: fromDb?.username ?? claims.username } : {}),
          roles,
          envKey: false,
        }
      }
    }
  }
  const key = apiKeyFromRequest(req)
  if (key) {
    // env 静态键：匿名凭证（控制面要拒绝它，数据面放行）
    if (cfg.apiKeys.includes(key)) return { roles: [], envKey: true }
    const owner = deps.apiKeys?.ownerOf(key)
    if (owner) {
      // API Key 认证也要带 username：否则明细会把调用者写成 #user_id（监控页那串 #1359 的来源）
      const u = deps.users?.byId(owner.user_id)
      return { userId: owner.user_id, ...(u?.username ? { username: u.username } : {}), roles: [], envKey: false }
    }
  }
  return ANONYMOUS
}

/** 登录换 token：claims 里必须有 user_id/roles，面板与数据面都靠它 */
/**
 * 签发：claims 与 Go 版逐字同形（uid/username/jti/iat/iss/sub + exp）。
 * 刻意**不写 roles**：角色以库为准，改完立刻生效；也让两边签的票互相认得。
 */
export function issueToken(
  user: { id: number; username: string },
  cfg: Config,
  jti: string = randomBytes(9).toString('base64url'),
): { token: string; expires_at: string; jti: string } {
  const iat = Math.floor(Date.now() / 1000)
  const claims: Claims =
    cfg.jwtExpireHours === -1
      ? // 永不过期：省略 exp（Go 版 -1 的语义就是"不写 exp"）
        { uid: user.id, username: user.username, jti, iat, iss: 'loomproxy', sub: 'user' }
      : {
          uid: user.id,
          username: user.username,
          jti,
          iat,
          iss: 'loomproxy',
          sub: 'user',
          exp: iat + (cfg.jwtExpireHours > 0 ? cfg.jwtExpireHours : 168) * 3600,
        }
  const token = signToken(claims, cfg.jwtSecret)
  return {
    token,
    expires_at: claims.exp ? new Date(claims.exp * 1000).toISOString() : new Date(0).toISOString(),
    jti,
  }
}

export function isWhitelisted(path: string, cfg: Config): boolean {
  return cfg.authWhitelist.some((p) => p !== '/' && (path === p || path.startsWith(`${p}/`)))
}
