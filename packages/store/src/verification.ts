// 验证码存储：与 Go 的 verification_codes 表逐列对齐，线上 MySQL 直连也用这张表。
// 值一律字符串/数字（node:sqlite 同步 API）；code_hash 是 sha256，明文不入库。
import type { Database } from './sqlite.ts'
import { nowIso } from './sqlite.ts'

export type VerificationRow = {
  id: number
  scene: string
  target: string
  code_hash: string
  attempts: number
  ip: string
  expires_at: string
  consumed_at: string | null
  created_at: string
}

export interface VerificationStore {
  /** 最新一行（按 id DESC），找不到返回 undefined */
  latest(scene: string, target: string): VerificationRow | undefined
  /** 当日计数：同 target 与同 ip 各自发码数（dayStart 由调用方算好） */
  countSince(target: string, ip: string, dayStartIso: string): { targetCount: number; ipCount: number }
  insert(row: Omit<VerificationRow, 'id' | 'attempts' | 'consumed_at' | 'created_at'>, createdAt?: string): number
  markAttempts(id: number, n: number): void
  /** 原子消费：WHERE consumed_at IS NULL，返回是否真的消费到（并发下同码仅一人成功） */
  consume(id: number): boolean
  deleteExpired(nowIso: string): number
  deleteExpiredForTarget(scene: string, target: string, nowIso: string): number
}

export class DbVerification implements VerificationStore {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  latest(scene: string, target: string): VerificationRow | undefined {
    return this.db.get<VerificationRow>(
      'SELECT * FROM verification_codes WHERE scene = ? AND target = ? ORDER BY id DESC LIMIT 1',
      scene, target,
    )
  }

  countSince(target: string, ip: string, dayStartIso: string): { targetCount: number; ipCount: number } {
    const t = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM verification_codes WHERE target = ? AND created_at >= ?', target, dayStartIso,
    )?.n ?? 0
    const i = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM verification_codes WHERE ip = ? AND created_at >= ?', ip, dayStartIso,
    )?.n ?? 0
    return { targetCount: Number(t), ipCount: Number(i) }
  }

  insert(row: Omit<VerificationRow, 'id' | 'attempts' | 'consumed_at' | 'created_at'>, createdAt?: string): number {
    const now = createdAt ?? nowIso()
    return this.db.run(
      `INSERT INTO verification_codes (scene, target, code_hash, attempts, ip, expires_at, consumed_at, created_at)
       VALUES (?,?,?,?,?,?,NULL,?)`,
      row.scene, row.target, row.code_hash, 0, row.ip, row.expires_at, now,
    ).lastInsertRowid
  }

  markAttempts(id: number, n: number): void {
    this.db.run('UPDATE verification_codes SET attempts = ? WHERE id = ?', n, id)
  }

  consume(id: number): boolean {
    return this.db.run(
      'UPDATE verification_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', nowIso(), id,
    ).changes > 0
  }

  deleteExpired(now: string): number {
    return this.db.run('DELETE FROM verification_codes WHERE expires_at <= ?', now).changes
  }

  deleteExpiredForTarget(scene: string, target: string, now: string): number {
    return this.db.run(
      'DELETE FROM verification_codes WHERE scene = ? AND target = ? AND expires_at <= ?', scene, target, now,
    ).changes
  }
}
