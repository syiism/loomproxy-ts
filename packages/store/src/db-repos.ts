// 仓库层（SQLite 实现）：每个 Repo 对应一张表/一组表，接口与内存实现同名同义。
// 面板读的字段形状（user.plan / user.roles[].code / u.deleted_at …）在这里一次定死。
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { compareSync as bcryptCompare } from 'bcryptjs'
import type { CallLogPage, CallLogQuery, CallLogRow, SettingDecl, SettingType, SourceMeta } from '@loomproxy/contract'
import { isValidSettingType, normalizeUsername, validUsername } from '@loomproxy/contract'
import { type Database, bool, boolInt, nowIso, type SqlValue } from './sqlite.ts'
import type { CallLogStore, NewCallLog } from './call-logs.ts'
import type { DataSourceRow, DataSourceStore } from './data-sources.ts'
import type { SettingsStore, SettingRow } from './settings.ts'
import type { PlanView, RoleView, SessionUser, UserStore } from './users.ts'

// ---------- 口令 ----------

const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 } as const

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  // Go 版备份里的口令是 bcrypt（$2a$10$…），迁移后要能登录；新口令仍一律 scrypt。
  // 只认 legacy 前缀，避免任何未知格式被当成"通过"。
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    return bcryptCompare(password, stored)
  }
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string]
  const salt = Buffer.from(saltB64, 'base64url')
  const expect = Buffer.from(hashB64, 'base64url')
  const got = scryptSync(password, salt, expect.length, { N: Number(n), r: Number(r), p: Number(p) })
  return got.length === expect.length && timingSafeEqual(got, expect)
}

// ---------- 用户与角色 ----------

export type UserView = SessionUser & {
  email: string
  content_consent: boolean
  plan_id: number | null
  plan: PlanView | null
  created_at: string
  updated_at: string
  last_login_at: string | null
  deleted_at: string | null
}

type UserRow = {
  id: number
  username: string
  nickname: string
  email: string
  password_hash: string
  status: number
  content_consent: number
  plan_id: number | null
  last_login_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

type PlanRow = { id: number; name: string; code: string; description: string; status: number; is_default: number; created_at: string }

export interface SessionStore {
  create(userId: number, jti: string, expiresAt: string, ip: string, userAgent: string): void
  /** 多设备监控：保留 keepJti + 最近 maxKeep-1 个活跃会话，其余撤销；返回撤销数 */
  revokeExcess(userId: number, keepJti: string, maxKeep: number): number
  /** 这张票在不在本库（跨版本/跨库签发的票不在） */
  exists(jti: string): boolean
  /** jti 是否仍然有效（未撤销、未过期）；用户被禁用也视为失效 */
  isActive(jti: string): boolean
  listByUser(userId: number): Array<{ id: number; jti: string; ip: string; user_agent: string; created_at: string; expires_at: string }>
  revoke(jti: string): void
  revokeOthers(userId: number, keepJti: string): number
}

export class DbSessions implements SessionStore {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  create(userId: number, jti: string, expiresAt: string, ip: string, userAgent: string): void {
    const now = nowIso()
    this.db.run(
      'INSERT INTO sessions (user_id, jti, ip, user_agent, created_at, expires_at, last_active_at) VALUES (?,?,?,?,?,?,?)',
      userId, jti, ip, userAgent, now, expiresAt, now,
    )
  }

  revokeExcess(userId: number, _keepJti: string, maxKeep: number): number {
    if (maxKeep <= 0) return 0
    // 保留最近 maxKeep 个活跃会话（last_active_at 为 NULL 排最后=最旧），其余撤销。
    // 用窗口函数一次算完，SQLite 3.25+ / MySQL 8 都支持；登录场景刚建的会话 last_active_at=now
    // 必是最近，所以"保留最近 N 个"与 Go 的"保留本次+最近 N-1 个"等价。
    return this.db.run(
      `UPDATE sessions SET revoked_at = ? WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (ORDER BY (last_active_at IS NULL), last_active_at DESC, id DESC) rn
             FROM sessions WHERE user_id = ? AND revoked_at IS NULL
         ) WHERE rn > ?
       )`,
      nowIso(), userId, maxKeep,
    ).changes
  }

  exists(jti: string): boolean {
    return (this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE jti = ?', jti)?.n ?? 0) > 0
  }

  isActive(jti: string): boolean {
    const row = this.db.get<{ revoked_at: string | null; expires_at: string; status: number; deleted_at: string | null }>(
      `SELECT s.revoked_at, s.expires_at, u.status, u.deleted_at
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.jti = ?`,
      jti,
    )
    if (!row) return false
    if (row.revoked_at || row.deleted_at || row.status !== 1) return false
    // jwt_expire_hours=-1（永不过期）时 issueToken 把 expires_at 写成 1970 零值哨兵；
    // Go 版对应写 100 年后。这里把哨兵认作"无到期时间"，否则永不过期票会在落库瞬间就 401。
    const expires = Date.parse(row.expires_at)
    if (expires <= 0) return true // 0 = 1970 哨兵 = 永不过期
    return expires > Date.now()
  }

  listByUser(userId: number) {
    return this.db.all(
      'SELECT id, jti, ip, user_agent, created_at, expires_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY id DESC',
      userId,
    ) as Array<{ id: number; jti: string; ip: string; user_agent: string; created_at: string; expires_at: string }>
  }

  revoke(jti: string): void {
    this.db.run('UPDATE sessions SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL', nowIso(), jti)
  }

  revokeOthers(userId: number, keepJti: string): number {
    return this.db.run(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND jti <> ? AND revoked_at IS NULL',
      nowIso(), userId, keepJti,
    ).changes
  }
}

export interface ApiKeyView { id: number; name: string; key: string; created_at: string }
export interface ApiKeyStore {
  listByUser(userId: number): ApiKeyView[]
  create(userId: number, name: string, key: string): ApiKeyView
  revoke(userId: number, id: number): boolean
  /** 密钥 → 归属用户（数据面静态键不走这里，那是 env API_KEYS） */
  ownerOf(key: string): { user_id: number } | undefined
}

export class DbApiKeys implements ApiKeyStore {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  listByUser(userId: number): ApiKeyView[] {
    return this.db.all<ApiKeyView>(
      'SELECT id, name, key, created_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY id DESC',
      userId,
    )
  }

  create(userId: number, name: string, key: string): ApiKeyView {
    const now = nowIso()
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO api_keys (user_id, name, key, created_at) VALUES (?,?,?,?)', userId, name, key, now,
    )
    return { id: lastInsertRowid, name, key, created_at: now }
  }

  revoke(userId: number, id: number): boolean {
    return this.db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', nowIso(), id, userId).changes > 0
  }

  ownerOf(key: string) {
    return this.db.get<{ user_id: number }>('SELECT user_id FROM api_keys WHERE key = ? AND revoked_at IS NULL', key)
  }
}

export class DbUsers implements UserStore {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  private rolesOf(userId: number): RoleView[] {
    return this.db.all<RoleView>(
      `SELECT r.id, r.code, r.name, r.description FROM roles r
         JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ? ORDER BY r.id`,
      userId,
    )
  }

  private planOf(planId: number | null): PlanView | null {
    if (planId === null) return null
    const p = this.db.get<PlanRow>('SELECT * FROM plans WHERE id = ?', planId)
    return p ? { id: p.id, name: p.name, code: p.code, description: p.description } : null
  }

  view(row: UserRow): UserView {
    return {
      id: row.id,
      username: row.username,
      nickname: row.nickname,
      email: row.email,
      status: row.status,
      content_consent: bool(row.content_consent),
      plan_id: row.plan_id,
      plan: this.planOf(row.plan_id),
      roles: this.rolesOf(row.id),
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_login_at: row.last_login_at,
      deleted_at: row.deleted_at,
    }
  }

  byId(id: number): UserView | undefined {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', id)
    return row ? this.view(row) : undefined
  }

  byUsernameOrEmail(login: string): UserRow | undefined {
    const v = login.trim().toLowerCase()
    return this.db.get<UserRow>(
      'SELECT * FROM users WHERE deleted_at IS NULL AND (lower(username) = ? OR lower(email) = ?)',
      v, v,
    )
  }

  verify(login: string, password: string): UserView | undefined {
    const row = this.byUsernameOrEmail(login)
    if (!row) return undefined
    if (!verifyPassword(password, row.password_hash)) return undefined
    return this.view(row)
  }

  verifyWithLogin(login: string, password: string): { user: UserView; row: UserRow } | undefined {
    const row = this.byUsernameOrEmail(login)
    if (!row || !verifyPassword(password, row.password_hash)) return undefined
    return { user: this.view(row), row }
  }

  touchLogin(id: number): void {
    this.db.run('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), id)
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL')?.n ?? 0
  }

  stats(): { total: number; active: number; admin: number; vip: number; deleted: number } {
    // 与 Go 的 Stats 同口径：按 roles.code 数，软删用户不算（GORM 的 User 有 DeletedAt，默认过滤）。
    // 一个用户同时有 admin 与 vip 两角时两边各计一次，normal_count 因此可能为负——照 Go 口径，不自行修正。
    const roleCount = (code: string): number =>
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
          WHERE r.code = ? AND u.deleted_at IS NULL`,
        code,
      )?.n ?? 0
    return {
      total: this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0,
      active: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE status = 1 AND deleted_at IS NULL")?.n ?? 0,
      admin: roleCount('admin'),
      vip: roleCount('vip'),
      deleted: this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NOT NULL')?.n ?? 0,
    }
  }

  /** 今日新增用户数：created_at >= 今日 0 点（起点由调用方按 kernel/clock 算好） */
  todayNew(sinceIso: string): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', sinceIso)?.n ?? 0
  }

  list(q: { page: number; pageSize: number; keyword?: string; status?: string; role?: string }): { total: number; list: UserView[] } {
    const where: string[] = []
    const params: SqlValue[] = []
    if (q.status === 'deleted') {
      where.push('u.deleted_at IS NOT NULL')
    } else {
      where.push('u.deleted_at IS NULL')
      if (q.status === 'active') where.push('u.status = 1')
      if (q.status === 'disabled') where.push('u.status = 0')
    }
    if (q.keyword) {
      where.push('(lower(u.username) LIKE ? OR lower(u.nickname) LIKE ? OR lower(u.email) LIKE ?)')
      const like = `%${q.keyword.toLowerCase()}%`
      params.push(like, like, like)
    }
    if (q.role) {
      where.push('EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code = ?)')
      params.push(q.role)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users u ${clause}`, ...params)?.n ?? 0
    const rows = this.db.all<UserRow>(
      `SELECT u.* FROM users u ${clause} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
      ...params, q.pageSize, (q.page - 1) * q.pageSize,
    )
    return { total, list: rows.map((r) => this.view(r)) }
  }

  create(input: { username: string; password: string; nickname?: string; email?: string; status?: number; planId?: number | null; roles?: string[] }): UserView {
    const name = normalizeUsername(input.username)
    // 唯一口径在 contract：1–16 码点。store 层兜底，任何创建路径（注册/管理端/播种）都过这里。
    if (!validUsername(name)) throw new Error(`用户名长度需为 1–16 个字符`)
    const now = nowIso()
    return this.db.tx(() => {
      const { lastInsertRowid } = this.db.run(
        `INSERT INTO users (username, nickname, email, password_hash, status, plan_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        name,
        input.nickname ?? input.username,
        (input.email ?? '').trim().toLowerCase(),
        hashPassword(input.password),
        input.status ?? 1,
        input.planId ?? null,
        now, now,
      )
      for (const code of input.roles ?? []) this.addRole(lastInsertRowid, code)
      const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', lastInsertRowid)!
      return this.view(row)
    })
  }

  private addRole(userId: number, code: string): void {
    const role = this.db.get<{ id: number }>('SELECT id FROM roles WHERE code = ?', code)
    if (!role) throw new Error(`未知角色 ${code}`)
    this.db.run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)', userId, role.id)
  }

  /** 角色覆盖：先清空再写（空数组 = 只保留基础身份） */
  setRoles(userId: number, codes: string[]): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM user_roles WHERE user_id = ?', userId)
      for (const code of codes) this.addRole(userId, code)
    })
  }

  update(userId: number, patch: { nickname?: string; email?: string; status?: number; planId?: number | null }): UserView | undefined {
    const sets: string[] = []
    const params: SqlValue[] = []
    if (patch.nickname !== undefined) { sets.push('nickname = ?'); params.push(patch.nickname) }
    if (patch.email !== undefined) { sets.push('email = ?'); params.push(patch.email.trim().toLowerCase()) }
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
    if (patch.planId !== undefined) { sets.push('plan_id = ?'); params.push(patch.planId) }
    if (sets.length === 0) return this.byId(userId)
    sets.push('updated_at = ?'); params.push(nowIso())
    params.push(userId)
    this.db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params)
    return this.byId(userId)
  }

  setPassword(userId: number, password: string): void {
    this.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(password), nowIso(), userId)
  }

  /** 软删：历史行（额度/日志）都要留着，只把账号摘掉 */
  softDelete(userId: number): void {
    this.db.run('UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), userId)
  }

  restore(userId: number): void {
    this.db.run('UPDATE users SET deleted_at = NULL, updated_at = ? WHERE id = ?', nowIso(), userId)
  }

  setConsent(userId: number, consent: boolean): void {
    this.db.run('UPDATE users SET content_consent = ?, updated_at = ? WHERE id = ?', boolInt(consent), nowIso(), userId)
  }
}

/** 兼容旧接口（InMemory 时代的签名）：按 id 取身份 */
export function asUserStore(users: DbUsers): UserStore {
  return {
    verify: (u, p) => users.verify(u, p),
    byId: (id) => users.byId(id),
  }
}

export interface RoleStore {
  list(): RoleView[]
  create(input: { code: string; name: string; description?: string }): RoleView
  update(id: number, patch: { name?: string; description?: string }): RoleView | undefined
  remove(id: number): boolean
}

export class DbRoles implements RoleStore {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  list(): RoleView[] {
    return this.db.all<RoleView>('SELECT id, code, name, description FROM roles ORDER BY id')
  }

  create(input: { code: string; name: string; description?: string }): RoleView {
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO roles (code, name, description, created_at) VALUES (?,?,?,?)',
      input.code, input.name, input.description ?? '', nowIso(),
    )
    return { id: lastInsertRowid, code: input.code, name: input.name, description: input.description ?? '' }
  }

  update(id: number, patch: { name?: string; description?: string }): RoleView | undefined {
    const sets: string[] = []
    const params: SqlValue[] = []
    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name) }
    if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
    if (sets.length === 0) return this.list().find((r) => r.id === id)
    params.push(id)
    this.db.run(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`, ...params)
    return this.list().find((r) => r.id === id)
  }

  remove(id: number): boolean {
    return this.db.tx(() => {
      this.db.run('DELETE FROM user_roles WHERE role_id = ?', id)
      return this.db.run('DELETE FROM roles WHERE id = ?', id).changes > 0
    })
  }
}

export interface PlanStore {
  list(): PlanView[]
  byId(id: number): PlanView | undefined
  create(input: { name: string; code?: string; description?: string }): PlanView
  update(id: number, patch: { name?: string; description?: string; status?: number }): PlanView | undefined
  remove(id: number): boolean
}

export class DbPlans implements PlanStore {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  list(): PlanView[] {
    return this.db.all<PlanView>('SELECT id, name, code, description FROM plans WHERE status = 1 ORDER BY id')
  }

  byId(id: number): PlanView | undefined {
    return this.db.get<PlanView>('SELECT id, name, code, description FROM plans WHERE id = ?', id)
  }

  create(input: { name: string; code?: string; description?: string }): PlanView {
    const now = nowIso()
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO plans (name, code, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      input.name, input.code ?? `plan_${Date.now()}`, input.description ?? '', 1, now, now,
    )
    return { id: lastInsertRowid, name: input.name, code: input.code ?? `plan_${lastInsertRowid}`, description: input.description ?? '' }
  }

  update(id: number, patch: { name?: string; description?: string; status?: number }): PlanView | undefined {
    const sets: string[] = []
    const params: SqlValue[] = []
    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name) }
    if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
    if (sets.length === 0) return this.byId(id)
    sets.push('updated_at = ?'); params.push(nowIso()); params.push(id)
    this.db.run(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`, ...params)
    return this.byId(id)
  }

  remove(id: number): boolean {
    return this.db.run('DELETE FROM plans WHERE id = ?', id).changes > 0
  }
}
