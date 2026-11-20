// SQLite → MySQL SQL 翻译。纯函数、可单测。
import type { SqlValue } from './sqlite.ts'
// 只处理本项目实际用到的差异，不做通用 SQL 解析：
//   1) 标识符引号："limit"/"interface" → `limit`/`interface`（MySQL 保留字用反引号）
//   2) upsert：ON CONFLICT(cols) DO UPDATE SET x=excluded.y → ON DUPLICATE KEY UPDATE x=VALUES(y)
//   3) 表/列重命名由 APP_MAPPING 统一给出（TS schema → 线上 MySQL schema）。
export type Mapping = { tables?: Record<string, string>; columns?: Record<string, Record<string, string>> }

// TS 表 → 线上 MySQL 表。sessions/plans/redeem_codes 三张表名不同。
export const TABLE_MAP: Record<string, string> = {
  sessions: 'auth_sessions',
  plans: 'quota_plans',
  redeem_codes: 'redemption_codes',
}

// 列名差异（按 MySQL 表名键）：
//   auth_sessions.session_id ← TS jti
//   redeem_codes 无 plan_name 列（TS 有）；user_quota_overrides 用 group_code ← TS target（scope 恒为 source）
// 注意：全句替换有风险，列名映射仅在调用方明确需要时启用（见 mysql.ts 的 COL_MAP 用法）。
export const COLUMN_MAP: Record<string, Record<string, string>> = {
  auth_sessions: { jti: 'session_id' },
}

/** 把 SQLite 的 ON CONFLICT ... excluded.x 翻成 MySQL 的 ON DUPLICATE KEY ... VALUES(x)。 */
export function translateUpsert(sql: string): string {
  if (!/\bON\s+CONFLICT\b/i.test(sql)) return sql
  let out = sql.replace(/\bON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET\b/i, 'ON DUPLICATE KEY UPDATE')
  // MySQL 的 MAX() 是聚合函数，不能在 ON DUPLICATE KEY 里当标量用；GREATEST 才是标量最大值
  out = out.replace(/\bMAX\s*\(\s*([a-z_]+)\s*,\s*excluded\.\s*"?([a-z_]+)"?\s*\)/gi, 'GREATEST($1, VALUES($2))')
  out = out.replace(/\bexcluded\.\s*"([a-z_]+)"/gi, 'VALUES(`$1`)')
  out = out.replace(/\bexcluded\.\s*([a-z_]+)/gi, 'VALUES($1)')
  return out
}

/** SQLite 双引号标识符 → MySQL 反引号；bare 保留字 key/interval 也要引。 */
export function fixQuotes(sql: string): string {
  let out = sql.replace(/"([a-z_]+)"/gi, '`$1`')
  // 裸保留字列：key（api_keys/system_settings）、interval（quota_costs/quota_cost_plans）
  for (const word of ['key', 'interval']) {
    out = out.replace(new RegExp(`\\b${word}\\b`, 'gi'), (m, off: number, s: string) => {
      const before = s.slice(0, off)
      // 不动 ON DUPLICATE KEY UPDATE / PRIMARY KEY 里的关键字
      if (/ON\s+DUPLICATE\s+$/i.test(before) || /PRIMARY\s+$/i.test(before)) return m
      return `\`${word}\``
    })
  }
  return out
}

/** 应用表/列映射（词边界）。列映射需在表名映射之后、且只针对目标表的列，由 translate 统一处理。 */
export function applyMapping(sql: string, map: Mapping): string {
  let out = sql
  if (map.tables) {
    for (const [from, to] of Object.entries(map.tables)) {
      out = out.replace(new RegExp(`\\b${from}\\b`, 'g'), to)
    }
  }
  return out
}

/** 一条完整翻译：引号 → upsert → 表名映射。列名映射（如 jti→session_id）单独用 mapColumns。 */
export function translate(sql: string, map: Mapping = {}): string {
  let out = translateUpsert(sql) // 先处理 excluded."col"（此时引号还在，正则才匹配）
  out = out.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT IGNORE')
  out = fixQuotes(out)
  out = applyMapping(out, { tables: map.tables ?? TABLE_MAP })
  return out
}

/** 针对已知目标表的列重命名（词边界）。调用方决定对哪些 SQL 应用，避免误伤。 */
export function mapColumns(sql: string, table: string): string {
  const cols = COLUMN_MAP[table]
  if (!cols) return sql
  let out = sql
  for (const [from, to] of Object.entries(cols)) {
    out = out.replace(new RegExp(`\\b${from}\\b`, 'gi'), to)
  }
  return out
}

/**
 * api_keys 撤销语义对齐：Go 版撤销 = 物理删除（无 revoked_at 列），TS 版是软删。
 * 在 MySQL 后端把 TS 的软删语句翻成 Go 的物理删除，把 "revoked_at IS NULL" 过滤去掉。
 * sessions 的 revoked_at 在 MySQL 真实存在，不走这里。
 */
export function apiKeyRevokeToDelete(sql: string, params: SqlValue[]): { sql: string; params: SqlValue[] } {
  if (!/\bapi_keys\b/i.test(sql)) return { sql, params }
  // 软删 UPDATE → 物理 DELETE；去掉 SET revoked_at=? 对应的第一个参数（nowIso）
  const upd = /^UPDATE\s+api_keys\s+SET\s+revoked_at\s*=\s*\?\s+WHERE\s+(.*)$/i.exec(sql)
  if (upd) {
    const where = upd[1]!.replace(/\s+AND\s+revoked_at\s+IS\s+NULL/gi, '').trim()
    return { sql: `DELETE FROM api_keys WHERE ${where}`, params: params.slice(1) }
  }
  // 查询里 "AND revoked_at IS NULL" / " WHERE revoked_at IS NULL" 去掉（Go 无此列，全部都是有效行）
  const out = sql
    .replace(/\s+AND\s+revoked_at\s+IS\s+NULL/gi, '')
    .replace(/\s+WHERE\s+revoked_at\s+IS\s+NULL/gi, '')
  return { sql: out, params }
}

/**
 * 无唯一索引表的幂等 upsert（先查后写）。Go 版这两张表就是用应用层去重，MySQL 侧也没有
 * 唯一索引可依赖，ON DUPLICATE KEY 会插重复行。这里识别固定的两条 SQL，返回等价的
 * SELECT 探测 + UPDATE/INSERT 两步，由 MysqlDb 同步执行。
 *
 *   quota_limits:       冲突键 (plan_id, scope, target)
 *   user_quota_overrides: 冲突键 (user_id, target)——MySQL 列叫 group_code，scope 恒为 source，不参与
 */
export type AppUpsert = { probe: string; probeParams: SqlValue[]; update: string; updateParams: SqlValue[]; insert: string; insertParams: SqlValue[] }

// noUncheckedIndexedAccess 下解构出来是 SqlValue|undefined，这里全部按位置取并用 ?? null 兜底
function at(params: SqlValue[], i: number): SqlValue {
  return params[i] ?? null
}

export function appUpsert(sql: string, params: SqlValue[]): AppUpsert | undefined {
  // grant: INSERT INTO quota_limits (plan_id, scope, target, `limit`, created_at, updated_at) VALUES (?,?,?,?,?,?)...
  const grant = /INSERT INTO quota_limits\s*\([^)]*\)\s*VALUES\s*\(\?,\?,\?,\?,\?,\?\)/i.exec(sql)
  if (grant && /ON CONFLICT/i.test(sql)) {
    const planId = at(params, 0), scope = at(params, 1), target = at(params, 2)
    const limit = at(params, 3), created = at(params, 4), updated = at(params, 5)
    return {
      probe: 'SELECT id FROM quota_limits WHERE plan_id=? AND scope=? AND target=?',
      probeParams: [planId, scope, target],
      update: 'UPDATE quota_limits SET `limit`=?, updated_at=? WHERE plan_id=? AND scope=? AND target=?',
      updateParams: [limit, updated, planId, scope, target],
      insert: 'INSERT INTO quota_limits (plan_id,scope,target,`limit`,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      insertParams: [planId, scope, target, limit, created, updated],
    }
  }
  // setOverride: INSERT INTO user_quota_overrides (user_id, scope, target, `limit`, created_at, updated_at) VALUES ...
  const ovr = /INSERT INTO user_quota_overrides\s*\([^)]*\)\s*VALUES\s*\(\?,\?,\?,\?,\?,\?\)/i.exec(sql)
  if (ovr && /ON CONFLICT/i.test(sql)) {
    const userId = at(params, 0), target = at(params, 2) // scope 忽略（恒为 source）
    const limit = at(params, 3), created = at(params, 4), updated = at(params, 5)
    return {
      probe: 'SELECT id FROM user_quota_overrides WHERE user_id=? AND group_code=?',
      probeParams: [userId, target],
      update: 'UPDATE user_quota_overrides SET `limit`=?, updated_at=? WHERE user_id=? AND group_code=?',
      updateParams: [limit, updated, userId, target],
      insert: 'INSERT INTO user_quota_overrides (user_id,group_code,`limit`,created_at,updated_at) VALUES (?,?,?,?,?)',
      insertParams: [userId, target, limit, created, updated],
    }
  }
  return undefined
}

/**
 * system_settings：TS 有 sensitive 列（内存标记，敏感键只写不回显），Go/MySQL 表没有该列。
 * 去掉该列及其对应参数，避免写不存在的列。其余列（description/updated_at）两边都有。
 */
export function systemSettingsFix(sql: string, params: SqlValue[]): { sql: string; params: SqlValue[] } {
  if (!/\bsystem_settings\b/i.test(sql) || !/\bsensitive\b/i.test(sql)) return { sql, params }
  // SELECT sensitive ...：MySQL 无此列。改成常量 0，保留"行是否存在"语义（set() 靠 !cur 拒绝未注册键）。
  const sel = /^SELECT\s+sensitive\s+FROM\s+system_settings\b/i.exec(sql)
  if (sel) return { sql: sql.replace(/^SELECT\s+sensitive\s+FROM/i, 'SELECT 0 AS `sensitive` FROM'), params }
  // UPDATE ... SET ..., sensitive = ?, ... —— sensitive 占位符在 SET 段中的序号
  const setMatch = /\bSET\s+([\s\S]*?)\s+WHERE\b/i.exec(sql)
  if (setMatch) {
    const setClause = setMatch[1]!
    const assigns = setClause.split(',').map((s) => s.trim())
    const idx = assigns.findIndex((a) => /^\bsensitive\s*=\s*\?$/i.test(a))
    if (idx >= 0) {
      assigns.splice(idx, 1)
      const out = sql.replace(setClause, assigns.join(', '))
      return { sql: out, params: params.filter((_, i) => i !== idx) }
    }
  }
  // INSERT INTO system_settings (..., sensitive, ...) VALUES (?,...,?,...)
  const ins = /INSERT INTO system_settings\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(sql)
  if (ins) {
    const cols = ins[1]!.split(',').map((s) => s.trim())
    const idx = cols.findIndex((c) => /^sensitive$/i.test(c))
    if (idx >= 0) {
      cols.splice(idx, 1)
      // VALUES 里的 ? 数量与列数一致，params 前 idx 个后跳过一个
      const out = sql.replace(ins[0]!, `INSERT INTO system_settings (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      return { sql: out, params: params.filter((_, i) => i !== idx) }
    }
  }
  return { sql, params }
}

/**
 * 丢弃 MySQL 表不存在的列（连同对应参数）。用于：
 *   data_sources.media_type（Go 源声明在插件，不落库）
 *   api_call_logs 的 media_type → MySQL 列叫 media（见下方 rename 处理）
 * 只处理固定形状：UPDATE t SET ... col = ?, ... WHERE ... 与 INSERT INTO t (cols) VALUES (...)。
 */
export function dropColumns(
  sql: string,
  params: SqlValue[],
  table: string,
  cols: string[],
): { sql: string; params: SqlValue[] } {
  if (!new RegExp(`\\b${table}\\b`, 'i').test(sql)) return { sql, params }
  let out = sql
  let p = [...params]
  for (const col of cols) {
    // UPDATE: SET 段里的 `col = ?`
    const setM = /\bSET\s+([\s\S]*?)\s+WHERE\b/i.exec(out)
    if (setM) {
      const assigns = setM[1]!.split(',').map((s) => s.trim())
      const idx = assigns.findIndex((a) => new RegExp(`^${col}\\s*=\\s*\\?$`, 'i').test(a))
      if (idx >= 0) {
        assigns.splice(idx, 1)
        out = out.replace(setM[1]!, assigns.join(', '))
        p = p.filter((_, i) => i !== idx)
        continue
      }
    }
    // INSERT: 列清单与 VALUES 占位符
    const insM = new RegExp(`INSERT INTO ${table}\\s*\\(([^)]*)\\)\\s*VALUES\\s*\\(([^)]*)\\)`, 'i').exec(out)
    if (insM) {
      const cs = insM[1]!.split(',').map((s) => s.trim())
      const idx = cs.findIndex((c) => c.toLowerCase() === col.toLowerCase())
      if (idx >= 0) {
        cs.splice(idx, 1)
        out = out.replace(insM[0]!, `INSERT INTO ${table} (${cs.join(',')}) VALUES (${cs.map(() => '?').join(',')})`)
        p = p.filter((_, i) => i !== idx)
      }
    }
  }
  return { sql: out, params: p }
}

/**
 * user_quota_overrides 的读/删查询：TS 用 (scope,target)，线上 MySQL 只有 group_code（scope 恒为 source）。
 * effectiveLimit 的 `WHERE scope = ? AND target IN (?, '*')` → `WHERE group_code IN (?, '*')`，
 * 并去掉 scope 对应的那个参数（固定值 'source'）。
 */
export function overrideQueryFix(sql: string, params: SqlValue[]): { sql: string; params: SqlValue[] } {
  if (!/\buser_quota_overrides\b/i.test(sql)) return { sql, params }
  // 只处理 SELECT / DELETE（INSERT 由 appUpsert 处理，SELECT * 由反向列映射处理）
  if (/scope\s*=\s*\?\s+AND\s+target\s+IN/i.test(sql)) {
    const out = sql.replace(/\bscope\s*=\s*\?\s+AND\s+target\s+IN/i, 'group_code IN')
    // 参数顺序：user_id, scope('source'), target, ... → 去掉 scope
    return { sql: out, params: params.filter((_, i) => i !== 1) }
  }
  return { sql, params }
}

// ---- 日期格式：TS 用 ISO（...T...Z），MySQL datetime 用 'YYYY-MM-DD HH:mm:ss.SSS' ----
// 迁移工具用 toIso 把 MySQL 墙钟当 UTC（仅 ' '→'T' 加 'Z'），这里保持同一约定，保证读数一致。
const ISO_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})$/
const MYSQL_DT_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/

/** 入站参数：ISO 字符串 → MySQL datetime 字符串。 */
export function isoToMysql(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const m = ISO_RE.exec(v)
  return m ? `${m[1]} ${m[2]}` : v
}

/** 出站结果：MySQL datetime 字符串 → ISO（UTC，与迁移后的 SQLite 读数一致）。 */
export function mysqlToIso(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const m = MYSQL_DT_RE.exec(v)
  return m ? `${m[1]}T${m[2]}Z` : v
}
