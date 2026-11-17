// 访问判定：中间件与聚合搜索扇出**共用这一个口**（两份事实 = 安全偏差）。
// 判定顺序与 Go 版一致：源存在 → 源启用 → 匿名（免费套餐）→ 管理员 → 有套餐 → 套餐含该源。
import type { SourceMeta } from '@loomproxy/contract'

export const ACCESS_REASONS = {
  ok: '',
  not_found: 'not_found',
  disabled: 'disabled',
  need_login: 'need_login',
  no_plan: 'no_plan',
  ungranted: 'ungranted',
} as const
export type AccessReason = (typeof ACCESS_REASONS)[keyof typeof ACCESS_REASONS]

export type Caller =
  | { kind: 'anonymous'; /** 匿名走"免费套餐"那一档：它允许这个源就直接放行 */ freePlanAllows: boolean }
  | { kind: 'user'; isAdmin: boolean; /** 生效套餐是否解析得到 */ hasPlan: boolean; /** 套餐是否包含该源 */ granted: boolean }

export type AccessInput = {
  meta: SourceMeta | undefined
  /** data_sources.status == 1 */
  enabled: boolean
  caller: Caller
}

export function sourceAccessVerdict(input: AccessInput): AccessReason {
  if (!input.meta) return ACCESS_REASONS.not_found
  // 启用判定在管理员之前：管理员也不能用被禁用的源（与 Go 版同序）
  if (!input.enabled) return ACCESS_REASONS.disabled
  if (input.caller.kind === 'anonymous') {
    return input.caller.freePlanAllows ? ACCESS_REASONS.ok : ACCESS_REASONS.need_login
  }
  if (input.caller.isAdmin) return ACCESS_REASONS.ok
  if (!input.caller.hasPlan) return ACCESS_REASONS.no_plan
  if (!input.caller.granted) return ACCESS_REASONS.ungranted
  return ACCESS_REASONS.ok
}

export function accessMessage(reason: AccessReason): string {
  switch (reason) {
    case ACCESS_REASONS.not_found:
      return '数据源不存在'
    case ACCESS_REASONS.disabled:
      return '该数据源已被管理员禁用'
    case ACCESS_REASONS.need_login:
      return '请先登录后使用该数据源'
    case ACCESS_REASONS.no_plan:
      return '账号还没有生效套餐，请联系管理员'
    case ACCESS_REASONS.ungranted:
      return '你的套餐不包含该数据源'
    default:
      return ''
  }
}
