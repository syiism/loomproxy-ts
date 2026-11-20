// 运行期标记（不进面板、不参与任何业务判定）：只给"这段逻辑要知道上次是什么状态"用。
// 第一个使用方是管理员口令来源（generated / env / panel）——没有这个标记，
// 重启后就分不清"库里的哈希是 env 种的、随机生成的，还是管理员在面板改的"。
import { type Database, nowIso } from './sqlite.ts'

export class DbKv {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  get(key: string): string {
    return this.db.get<{ value: string }>('SELECT value FROM kv_state WHERE key = ?', key)?.value ?? ''
  }

  set(key: string, value: string): void {
    this.db.run(
      `INSERT INTO kv_state (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key, value, nowIso(),
    )
  }
}
