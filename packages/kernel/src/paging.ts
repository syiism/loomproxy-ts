// 分页夹只有一处定义（替代 Go 的 pagination-single-source-check）：
// 六个端点各抄一遍 `<1 || >100` 的值今天一致，但第七处可以静默不写。
export const PAGE_MAX = 100
export const PAGE_SIZE_MAX = 100

/** 页码：非法/越界一律回 1（不回 400——越界页码过去会算出负 offset） */
export function clampPage(v: unknown, def = 1): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return def
  return n
}

export function clampPageSize(v: unknown, def = 20): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return def
  return Math.min(n, PAGE_SIZE_MAX)
}

export function offsetOf(page: number, pageSize: number): number {
  return (Math.max(1, page) - 1) * Math.max(1, pageSize)
}
