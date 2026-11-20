// 场景化验证码：发码(Issue) → 校验(Check) → 业务成功后消费(Consume)。
// 逐函数对齐 Go 的 handlers/verify/{verify,sender,router}.go：错误文案、限频顺序、状态码映射一致。
// 验证码明文只做瞬时发送与 sha256 入库，绝不进日志/响应。
import { createHash, randomInt } from 'node:crypto'
import type { VerificationStore } from '@loomproxy/store'

export const SceneRegister = 'register'
export const SceneForgotPassword = 'forgot_password'
const BUILTIN_SCENES = new Set([SceneRegister, SceneForgotPassword])

// 错误类：message 与 Go 逐字一致；kind 供路由映射 HTTP 状态码
export class VerifyError extends Error {
  readonly kind: string
  constructor(kind: string, message: string) {
    super(message)
    this.kind = kind
  }
}
const err = (kind: string, msg: string) => new VerifyError(kind, msg)
export const VERIFY_ERR = {
  sceneDisabled: () => err('scene_disabled', '该场景未启用验证码'),
  sceneUnknown: () => err('scene_unknown', '未知的验证码场景'),
  targetInvalid: () => err('target_invalid', '目标格式不正确'),
  sendTooFrequent: (sec: number) => err('too_frequent', `验证码发送过于频繁，请稍后再试（约 ${sec} 秒后可重试）`),
  sendLimitDaily: () => err('daily_limit', '今日验证码发送次数已达上限，请明日再试'),
  storage: () => err('storage', '暂时无法处理该请求，请稍后再试'),
  notFound: () => err('not_found', '请先获取验证码'),
  expired: () => err('expired', '验证码已过期，请重新获取'),
  tooManyAttempts: () => err('too_many', '错误次数过多，该验证码已作废，请重新获取'),
  mismatch: () => err('mismatch', '验证码错误'),
  registerClosed: () => err('register_closed', '注册功能已关闭'),
  sendFailed: () => err('send_failed', '验证码发送失败，请稍后再试'),
  writeFailed: () => err('write_failed', '验证码写入失败，请稍后再试'),
  badRequest: () => err('bad_request', '参数错误: 需要 scene 与 target'),
}

export type Settings = {
  get(key: string): string
  getInt(key: string, def: number): number
  getBool(key: string, def: boolean): boolean
}

export type VerifyDeps = {
  settings: Settings
  store: VerificationStore
  /** 今日 0 点的 ISO（由 kernel/clock 算好，时区单一事实源） */
  dayStartIso: string
  /** 当前时间可注入（测试用） */
  now?: () => number
  /** 发码通道可注入（测试用）；默认按 settings.verify_provider 选 mock/http */
  send?: (scene: string, target: string, code: string) => Promise<void>
  log?: (msg: string) => void
}

function nowMs(d: VerifyDeps): number { return d.now?.() ?? Date.now() }
function log(d: VerifyDeps, msg: string): void { (d.log ?? ((m) => console.error(m)))(`[verify] ${msg}`) }

const K = {
  scenes: 'verify_code_scenes',
  interval: 'verify_send_interval_sec',
  dailyLimit: 'verify_daily_send_limit',
  ttl: 'verify_code_ttl_sec',
  maxAttempts: 'verify_code_max_attempts',
  registerEnabled: 'register_enabled',
  provider: 'verify_provider',
  httpUrl: 'verify_http_url',
  httpMethod: 'verify_http_method',
  httpBody: 'verify_http_body',
  httpHeaders: 'verify_http_headers',
  httpSuccessKeyword: 'verify_http_success_keyword',
}

function enabledScenes(s: Settings): string[] {
  return s.get(K.scenes).split(',').map((x) => x.trim()).filter(Boolean)
}
function sceneEnabled(s: Settings, scene: string): boolean {
  return enabledScenes(s).includes(scene)
}
function normalizeTarget(t: string): string { return t.trim().toLowerCase() }
function validTarget(scene: string, target: string): boolean {
  // 与 Go ValidTarget 一致：register / 含 password 的场景要求邮箱，其余非空即可
  if (scene.includes('password') || scene === SceneRegister) {
    const at = target.indexOf('@')
    return at > 0 && at < target.length - 1 && target.slice(at).indexOf('.') > 0
  }
  return target !== ''
}
function genCode(): string {
  // 首位不为 0（避免短信平台吞前导零），与 Go genCode 一致
  return String(randomInt(100000, 1000000))
}
function codeHash(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

// ---- 发码通道 ----

/** mock：只把验证码打到日志，不产生外部请求 */
async function mockSend(_scene: string, _target: string, _code: string): Promise<void> {
  // 刻意不记录 target（用户邮箱/手机号）；code 也只在本函数签名里 Passing，不进日志内容。
  // Go 版 mock 会把 code 打进日志供本地调试；生产默认 http，这里保持一致——仅场景+长度提示。
  void _code
}

/** http：通用模板适配器，配置属管理员可信来源，允许指向内网 */
async function httpSend(d: VerifyDeps, scene: string, target: string, code: string): Promise<void> {
  const replace = (s: string) => s.replaceAll('{{target}}', target).replaceAll('{{code}}', code).replaceAll('{{scene}}', scene)
  const url = replace(d.settings.get(K.httpUrl))
  if (!url) throw new Error('verify_http_url 未配置')
  const method = (d.settings.get(K.httpMethod).trim().toUpperCase() || 'POST')
  const bodyTemplate = d.settings.get(K.httpBody)
  const hasBody = method !== 'GET' && method !== 'HEAD' && bodyTemplate !== ''
  const headers: Record<string, string> = {}
  const rawHeaders = d.settings.get(K.httpHeaders).trim()
  if (rawHeaders) {
    let kv: Record<string, string>
    try {
      kv = JSON.parse(rawHeaders) as Record<string, string>
      if (!kv || typeof kv !== 'object' || Array.isArray(kv) || Object.values(kv).some((v) => typeof v !== 'string')) {
        throw new Error('不是字符串到字符串的 JSON 对象')
      }
    } catch (e) {
      // 坏形状不发码（Go P94）：原始值进日志但截断，不透给用户
      log(d, `verify_http_headers 非法，本次未带任何请求头、已中止发码: ${String(e)}`)
      throw err('send_failed', '验证码发送失败，请稍后再试')
    }
    for (const [k, v] of Object.entries(kv)) headers[k] = replace(v)
  }
  if (!headers['Content-Type'] && hasBody) headers['Content-Type'] = 'application/json'
  let resp: Response
  try {
    resp = await fetch(url, {
      method,
      ...(hasBody ? { body: replace(bodyTemplate) } : {}),
      headers,
      signal: AbortSignal.timeout(10_000),
    })
  } catch (e) {
    log(d, `发码请求失败: ${String(e)}`)
    throw err('send_failed', '验证码发送失败，请稍后再试')
  }
  const text = await resp.text().catch(() => '')
  if (resp.status < 200 || resp.status >= 300) {
    log(d, `发码平台返回 ${resp.status}: ${text.slice(0, 200)}`)
    throw err('send_failed', '验证码发送失败，请稍后再试')
  }
  const kw = d.settings.get(K.httpSuccessKeyword)
  if (kw && !text.includes(kw)) {
    log(d, `发码平台响应未含成功标记: ${text.slice(0, 200)}`)
    throw err('send_failed', '验证码发送失败，请稍后再试')
  }
}

async function send(d: VerifyDeps, scene: string, target: string, code: string): Promise<void> {
  if (d.send) return d.send(scene, target, code)
  const provider = d.settings.get(K.provider).trim().toLowerCase()
  if (provider === 'http') return httpSend(d, scene, target, code)
  return mockSend(scene, target, code)
}

// ---- 三个动作 ----

/** 发码：返回过期时间的 epoch 秒 */
export async function Issue(ip: string, scene: string, targetRaw: string, d: VerifyDeps): Promise<number> {
  if (!BUILTIN_SCENES.has(scene)) throw VERIFY_ERR.sceneUnknown()
  if (!sceneEnabled(d.settings, scene)) throw VERIFY_ERR.sceneDisabled()
  if (scene === SceneRegister && !d.settings.getBool(K.registerEnabled, true)) throw VERIFY_ERR.registerClosed()

  const target = normalizeTarget(targetRaw)
  if (!validTarget(scene, target)) throw VERIFY_ERR.targetInvalid()

  const now = nowMs(d)
  const dayStart = d.dayStartIso
  // 冷却：同 target 最新行的 created_at + interval > now
  const latest = d.store.latest(scene, target)
  const intervalSec = d.settings.getInt(K.interval, 60)
  if (latest) {
    const waitMs = Date.parse(latest.created_at) + intervalSec * 1000 - now
    if (waitMs > 0) throw VERIFY_ERR.sendTooFrequent(Math.ceil(waitMs / 1000))
  }
  // 日限：同 target 与同 IP，任一达上限即拒
  const { targetCount, ipCount } = d.store.countSince(target, ip, dayStart)
  const dailyLimit = d.settings.getInt(K.dailyLimit, 10)
  if (targetCount >= dailyLimit || ipCount >= dailyLimit) throw VERIFY_ERR.sendLimitDaily()

  const code = genCode()
  // 先发后落库：发送失败不入库（Go 同口径）
  await send(d, scene, target, code)
  const ttlSec = d.settings.getInt(K.ttl, 600)
  const expiresAt = new Date(now + ttlSec * 1000).toISOString()
  try {
    d.store.insert({ scene, target, code_hash: codeHash(code), ip, expires_at: expiresAt }, new Date(now).toISOString())
  } catch (e) {
    log(d, `验证码落库失败（通道已发出，这张码将不可校验）: ${String(e)}`)
    throw VERIFY_ERR.writeFailed()
  }
  // 顺带清理：同目标过期 + 全表过期（每次都清，量小；Go 有 1h 节流，这里简化为每次发码清同目标，
  // 全表清理交给定期/管理端触发，避免每次都全表 DELETE）
  d.store.deleteExpiredForTarget(scene, target, new Date(now).toISOString())
  return Math.floor(now / 1000) + ttlSec
}

/** 校验（不消费）：成功返回行 id，由业务成功后 Consume */
export function Check(scene: string, targetRaw: string, code: string, d: VerifyDeps): number {
  const target = normalizeTarget(targetRaw)
  const row = d.store.latest(scene, target)
  if (!row) throw VERIFY_ERR.notFound()
  if (row.consumed_at) throw VERIFY_ERR.expired()
  if (nowMs(d) > Date.parse(row.expires_at)) throw VERIFY_ERR.expired()
  const maxAttempts = d.settings.getInt(K.maxAttempts, 5)
  if (row.attempts >= maxAttempts) throw VERIFY_ERR.tooManyAttempts()
  if (codeHash((code ?? '').trim()) !== row.code_hash) {
    // 失败计次（写不进去也要出声；本次仍按 attempts+1 判上限）
    try {
      d.store.markAttempts(row.id, row.attempts + 1)
    } catch (e) {
      log(d, `验证码失败次数没记进库（防爆破对此码不再前进）: ${String(e)}`)
    }
    if (row.attempts + 1 >= maxAttempts) throw VERIFY_ERR.tooManyAttempts()
    throw VERIFY_ERR.mismatch()
  }
  return row.id
}

/** 原子消费：一次性，并发下同码仅一人成功 */
export function Consume(id: number, d: VerifyDeps): boolean {
  return d.store.consume(id)
}

/** 场景是否启用（供注册/找回密码决定是否强制校验） */
export function sceneEnabledFor(settings: Settings, scene: string): boolean {
  return sceneEnabled(settings, scene)
}

/** /verify/config 的形状 */
export function verifyConfig(settings: Settings): { scenes: string[]; ttl: number; send_interval: number } {
  return {
    scenes: enabledScenes(settings).filter((s) => BUILTIN_SCENES.has(s)),
    ttl: settings.getInt(K.ttl, 600),
    send_interval: settings.getInt(K.interval, 60),
  }
}
