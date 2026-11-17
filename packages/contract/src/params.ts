// 请求参数（迁移-TS-2 §11）：值**永远是字符串**——数字断言是静默死代码。
// __uid 是平台注入的当前用户 ID（数字），"_" 前缀是平台保留键。
export type Params = Record<string, string> & { __uid?: number }

export function paramString(params: Params, key: string): string {
  const v = params[key]
  return typeof v === 'string' ? v : ''
}

/** 搜索词的多写法：观测层认这几个别名，源读自己的那个（迁移-TS-1 §5.2） */
export const KEYWORD_KEYS = ['key', 'keyword', 'query', 'wd'] as const

export function keywordOf(params: Params): string {
  for (const k of KEYWORD_KEYS) {
    const v = paramString(params, k)
    if (v) return v
  }
  return ''
}
