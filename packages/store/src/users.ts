// 账号与会话：本轮只有"env 单管理员"（AUTH_ENABLED 与 ADMIN_* 的既有语义，见 ② §9）。
// 用户表/角色表/多租户是后续工作，接口先定成"按凭证换出一个身份视图"，接库时只换实现。
import { timingSafeEqual } from 'node:crypto'

/** 角色视图：面板认 `r.code`（isAdmin() 就是这么判的），所以这里给对象而不是字符串。 */
export type RoleView = { id: number; code: string; name: string; description: string }
export type PlanView = { id: number; name: string; code: string; description: string }

export type SessionUser = {
  id: number
  username: string
  nickname: string
  email: string
  status: number
  roles: RoleView[]
}

export interface UserStore {
  /** 用户名/密码 → 身份；不匹配返回 undefined（调用方统一回「用户名或密码错误」） */
  verify(username: string, password: string): SessionUser | undefined
  byId(id: number): SessionUser | undefined
}

/** 单管理员：账号来自 ADMIN_USERNAME/ADMIN_PASSWORD（未设置时按 Go 版口径生成随机密码并打印） */
export class EnvAdminUser implements UserStore {
  readonly username: string
  private readonly password: string
  private readonly user: SessionUser

  constructor(username: string, password: string, opts: { randomPassword?: string } = {}) {
    this.username = (username || 'admin').trim().toLowerCase()
    this.password = password || opts.randomPassword || ''
    this.user = {
      id: 1,
      username: this.username,
      nickname: this.username,
      email: '',
      status: 1,
      roles: [{ id: 1, code: 'admin', name: '管理员', description: '' }],
    }
  }

  /** 启动日志用：密码是不是自动生成的（自动生成时调用方必须把它打出来，否则没人能登录） */
  get generatedPassword(): string {
    return this.password
  }

  verify(username: string, password: string): SessionUser | undefined {
    if (!this.password) return undefined
    const u = (username ?? '').trim().toLowerCase()
    if (!sameString(u, this.username) || !sameString(password ?? '', this.password)) return undefined
    return this.user
  }

  byId(id: number): SessionUser | undefined {
    return id === this.user.id ? this.user : undefined
  }
}

function sameString(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
