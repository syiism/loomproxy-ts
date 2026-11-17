// 出口的两个平台改写（迁移-TS-1 §5.4）：打标与观测抽取。源不必填 source/kind，填了也会被覆盖。
import type { BookItem, CallSubject, SearchResponse } from '@loomproxy/contract'

/**
 * 每条结果写 source；kind 首项写源码。
 * 保持原形状：源给的是字符串就回字符串、给的是数组就回数组（Legado 两种都吃）。
 * 已有同名项挪到最前、不重复第二遍；**其它项原样保留**（平台不替源改标签）。
 */
export function prependSourceToKind(v: unknown, source: string): unknown {
  if (v === undefined || v === null || v === '') return source
  if (typeof v === 'string') {
    const rest = v
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '' && p !== source)
    return rest.length === 0 ? source : [source, ...rest].join(',')
  }
  if (Array.isArray(v)) {
    const rest = v.filter((e) => !(typeof e === 'string' && e.trim() === source))
    return [source, ...rest]
  }
  return v
}

/** 没有 bookList 这个键就不打标：带内错误正文长这样，打标等于给失败响应塞空列表 */
export function stampSearchSource(result: unknown, source: string): unknown {
  if (!result || typeof result !== 'object') return result
  if (!('bookList' in (result as Record<string, unknown>))) return result
  const r = result as SearchResponse
  if (!Array.isArray(r.bookList)) return result
  const bookList = r.bookList.map((b) => ({ ...b, source, kind: prependSourceToKind(b.kind, source) }))
  return { ...r, bookList }
}
