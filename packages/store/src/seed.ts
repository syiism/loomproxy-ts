// 内置系统设置：键名/初值/类型/说明与 Go 版 db/seed.go 的 settings 逐条对齐。
// 三条纪律（同 Go 版）：
//   ① 行不存在才建（用这里的初值），已存在只对账 type —— **绝不覆盖管理员改过的值**；
//   ② 废弃键必须同时从这份清单里删掉，否则"每次启动先删再种回来"；
//   ③ 源自己的设置项不在这里（走 manifest 的 settings 声明位，见 source-host）。
import type { SettingDecl } from '@loomproxy/contract'

export const BUILTIN_SETTINGS: SettingDecl[] = [
  { key: 'register_enabled', type: 'bool', default: 'true', description: '是否允许注册' },
  { key: 'default_role', type: 'string', default: 'user', description: '新用户默认角色' },
  { key: 'default_quota_plan', type: 'string', default: 'free', description: '新用户默认额度套餐' },
  { key: 'email_domain_allowlist', type: 'string', default: '', description: '允许注册的邮箱域名白名单，逗号分隔；后缀匹配、大小写不敏感；留空=不按白名单限制' },
  { key: 'email_domain_blocklist', type: 'string', default: '', description: '禁止注册的邮箱域名黑名单，逗号分隔；后缀匹配、大小写不敏感；留空=不按黑名单限制。白名单非空时先过白名单再排除黑名单' },
  { key: 'maintenance_mode', type: 'bool', default: 'false', description: '维护模式' },
  { key: 'jwt_expire_hours', type: 'number', default: '168', description: '登录 token 有效时长（小时），-1 表示永不过期；用户可在个人中心设置自己的时长覆盖' },
  { key: 'proxy_enabled_sources', type: 'string', default: '', description: '启用 IP 代理池的数据源/接口，逗号分隔（如 novel_a/chapter 单接口、novel_a 整源）；留空表示不限制（全部走代理）' },
  { key: 'rank_public_sources', type: 'string', default: '', description: '允许普通用户查看排行榜的数据源，逗号分隔的数据源码；留空=不对普通用户开放任何榜单。管理员不受此名单限制' },
  { key: 'aggregate_max_sources', type: 'number', default: '8', description: '聚合搜索（search 带 sources 参数）一次最多打几个源；默认 8、硬顶 64' },
  { key: 'announcement', type: 'string', default: '', description: '站内公告（留空=不展示；登录后面板顶部横幅展示，用户可关闭，内容变更后重新展示）' },
  { key: 'verify_code_scenes', type: 'string', default: '', description: '启用验证码校验的场景，逗号分隔（register、forgot_password）；留空=全部关闭，业务行为不变' },
  { key: 'verify_send_interval_sec', type: 'number', default: '60', description: '验证码发送冷却：同一目标两次发码的最小间隔（秒）' },
  { key: 'verify_daily_send_limit', type: 'number', default: '10', description: '验证码每日上限：同一目标/同一 IP 每日发码次数（北京时间零点重置）' },
  { key: 'verify_code_ttl_sec', type: 'number', default: '600', description: '验证码有效期（秒）' },
  { key: 'verify_code_max_attempts', type: 'number', default: '5', description: '单个验证码最大验证失败次数（超过作废）' },
  { key: 'verify_provider', type: 'string', default: 'mock', description: '发码通道：mock=仅打印服务端日志（开发默认）；http=通用 HTTP 模板适配器' },
  { key: 'verify_http_url', type: 'string', default: '', description: 'http 通道发码接口地址，支持占位符 {{target}} {{code}} {{scene}}' },
  { key: 'verify_http_method', type: 'string', default: 'POST', description: 'http 通道请求方法' },
  { key: 'verify_http_headers', type: 'json_object', default: '', description: 'http 通道请求头（字符串到字符串的 JSON 对象），如 {"authorization":"Bearer xx"}' },
  { key: 'verify_http_body', type: 'json', default: '', description: 'http 通道请求体模板（JSON），支持 {{target}} {{code}} {{scene}} 占位符' },
  { key: 'verify_http_success_keyword', type: 'string', default: '', description: 'http 通道成功判定关键字（响应体需包含，留空=HTTP 2xx 即成功）' },
  { key: 'auto_block_enabled', type: 'bool', default: 'false', description: 'IP 自动拉黑开关：滑动窗口内 403/429 次数达阈值自动加入黑名单（回环地址永不自动拉黑）' },
  { key: 'auto_block_threshold', type: 'number', default: '30', description: 'IP 自动拉黑阈值：窗口内允许的 403/429 次数上限' },
  { key: 'auto_block_window_sec', type: 'number', default: '60', description: 'IP 自动拉黑统计窗口（秒）' },
  { key: 'device_watch_enabled', type: 'bool', default: 'false', description: '多设备监控开关：开启后登录时把超出上限的旧会话移出（保留最近的）。只按会话数处置，不按 IP 数' },
  { key: 'max_active_sessions', type: 'number', default: '5', description: '同一账号允许同时存在的活跃登录会话数上限（登录时按最后活跃时间保留这么多）' },
  { key: 'device_watch_window_days', type: 'number', default: '7', description: '设备与密钥监控的统计窗口（天）' },
  { key: 'suspect_distinct_ips', type: 'number', default: '8', description: '窗口内不同 IP 数达到该值即在面板标红（只标红，不因此踢人）' },
]

/**
 * 内置套餐的每源默认额度（与 Go 的 builtinPlanLimitDefaults 同值）。
 * **限额即授权**：这一行的存在同时就是"这个套餐能用这个源"——所以"新接入一个源"
 * 必须给它补上这一行，否则老用户会突然"没有任何可用数据源"。
 * 只在**新建套餐**与**新接入源**两个时点播种；管理员删掉的授权不许每次启动又发回去。
 */
export const BUILTIN_PLAN_LIMIT_DEFAULTS = { free: 100, vip: 1000, admin: -1 } as const

export function defaultPerSourceLimit(planCode: string): number {
  const v = (BUILTIN_PLAN_LIMIT_DEFAULTS as Record<string, number>)[planCode]
  return v ?? -1 // 自定义套餐没有默认档：-1（不限）
}

/** 已废弃的键：启动期清掉（留着会以"未被管理的 key"赖在面板「自定义配置」卡里，看着像还能生效） */
export const REMOVED_SETTINGS = ['rank_public_enabled', 'legado_import_url', 'site_name']

type SettingsLike = { register(decls: SettingDecl[]): void; remove(key: string): boolean }

/** 幂等播种：行不存在才建、已存在只对账 type（由 SettingsStore.register 保证） */
export function seedBuiltinSettings(settings: SettingsLike, log?: (msg: string) => void): void {
  settings.register(BUILTIN_SETTINGS)
  for (const key of REMOVED_SETTINGS) {
    if (settings.remove(key)) log?.(`已移除废弃设置项: ${key}`)
  }
}
