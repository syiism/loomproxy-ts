// 参数注入（迁移-TS-1 §5.1）：只注入声明过的键、值永远是字符串、空值不注入。
import type { ActionName, Params, SourceMeta } from '@loomproxy/contract'
import { ACTION_DEFAULT_PARAMS } from '@loomproxy/contract'

/** 该动作要注入的 query 键：manifest.params[action] 优先，否则用标准集 */
export function declaredParams(
  params: Record<string, string[]> | undefined,
  action: string,
): readonly string[] {
  const explicit = params?.[action]
  if (explicit && explicit.length > 0) return explicit
  return ACTION_DEFAULT_PARAMS[action as ActionName] ?? []
}

export function buildParams(
  declared: readonly string[],
  query: Record<string, unknown>,
  opts: { baseUrl?: string; uid?: number } = {},
): Params {
  const params: Params = {}
  for (const key of declared) {
    // "_" 前缀是平台保留键，源不许声明
    if (key.startsWith('_')) continue
    const v = query[key]
    if (typeof v === 'string' && v !== '') params[key] = v
  }
  if (!params['baseUrl'] && opts.baseUrl) params['baseUrl'] = opts.baseUrl
  if (opts.uid !== undefined) params.__uid = opts.uid
  return params
}

/** 必填参数校验：缺 → 400，不让源返回带内错误正文（HTTP 200 会被当正文渲染） */
export function missingRequired(meta: SourceMeta, action: string, params: Params): string[] {
  const req = meta.required_params?.[action] ?? []
  return req.filter((k) => !params[k])
}
