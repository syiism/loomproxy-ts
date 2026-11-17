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

type Claims = { user_id?: number; username?: string; roles?: string[]; exp?: number; jti?: string }

/** 身份解析需要的存储（会话吊销要现行查库：撤销之后旧票必须立刻失效） */
export type IdentityDeps = {
  sessions?: { isActive(jti: string): boolean }
  apiKeys?: { ownerOf(key: string): { user_id: number } | undefined }
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
      if (k === 'loomproxy_token') return rest.join('=')
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
      const revoked = claims.jti !== undefined && deps.sessions !== undefined && !deps.sessions.isActive(claims.jti)
      if (!revoked) {
        return {
          ...(claims.user_id !== undefined ? { userId: claims.user_id } : {}),
          ...(claims.username ? { username: claims.username } : {}),
          roles: claims.roles ?? [],
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
    if (owner) return { userId: owner.user_id, roles: [], envKey: false }
  }
  return ANONYMOUS
}

/** 登录换 token：claims 里必须有 user_id/roles，面板与数据面都靠它 */
export function issueToken(
  user: { id: number; username: string; roles: string[] },
  cfg: Config,
  jti: string = randomBytes(9).toString('base64url'),
): { token: string; expires_at: string; jti: string } {
  const expSec = Math.floor(Date.now() / 1000) + cfg.jwtExpireHours * 3600
  const token = signToken(
    { user_id: user.id, username: user.username, roles: user.roles, exp: expSec, jti },
    cfg.jwtSecret,
  )
  return { token, expires_at: new Date(expSec * 1000).toISOString(), jti }
}

export function isWhitelisted(path: string, cfg: Config): boolean {
  return cfg.authWhitelist.some((p) => p !== '/' && (path === p || path.startsWith(`${p}/`)))
}
