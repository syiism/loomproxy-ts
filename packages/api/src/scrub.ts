// 带内错误正文的脱敏（迁移-TS-1 §5.4）：认证两种形状——规范 DTO 与源自己拼的松散对象。
// **必须与 observeCall 认的同一组形状**，否则"监控标成带内失败、文案却照原样下发"。
export function sanitizeUpstreamMsg(msg: string): string {
  return msg.includes('://') ? '上游请求失败，请稍后重试' : msg
}

export function scrubInBandMsg(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  const r = result as Record<string, unknown>
  if (r['contentType'] !== 'error') return result
  const data = r['data']
  if (!data || typeof data !== 'object') return result
  const d = data as Record<string, unknown>
  const msg = d['message']
  if (typeof msg === 'string' && msg !== '') d['message'] = sanitizeUpstreamMsg(msg)
  return result
}
