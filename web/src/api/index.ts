// 端点方法表：只列本 TS 后端**已经实现**的那几条（README「本轮落地的切片」）。
// 未实现的域（套餐/额度/卡密/用户管理）等 store 接库后再补，不在这里留假方法。
import { request } from './client.ts'

export type SearchTab = { tab_type: number; bd_id: string; name: string; media_type?: string }
export type DatasourceItem = {
  id: string
  name: string
  category: string
  media_type?: string
  search_tab: SearchTab[]
  files: string[]
}
export type PluginInfo = {
  code: string
  version: string
  state: 'active' | 'failed' | 'disabled'
  isolation: string
  generation: number
  inflight: number
  dir: string
  last_error?: string
}
export type CallLogRow = {
  id: number
  username: string
  ip: string
  source: string
  action: string
  status: number
  in_band_error: boolean
  in_band_reason: string
  in_band_code: string
  latency_ms: number
  created_at: string
  keyword: string
  book_name: string
  chapter_title: string
  book_ident: string
  chapter_ident: string
  media_type: string
  result_count: number
  content_withheld: boolean
  plugin_version: string
}
export type CallLogPage = { total: number; page: number; page_size: number; list: CallLogRow[] }

export const authApi = {
  login: (username: string, password: string) =>
    request<{ token: string; expires_at: string; user: { id: number; username: string; nickname: string; roles: string[] } }>(
      '/auth/login',
      { method: 'POST', body: { username, password } },
    ),
  me: () => request<{ id: number; username: string; nickname: string; roles: string[] }>('/auth/me'),
  logout: () => request<Record<string, never>>('/auth/logout', { method: 'POST' }),
}

export const miscApi = {
  datasources: () => request<DatasourceItem[]>('/datasources'),
  endpoints: () => request<Array<{ id: string; name: string; endpoints: unknown[] }>>('/endpoints'),
}

export const pluginApi = {
  list: () => request<PluginInfo[]>('/admin/sources/plugins'),
  versions: () => request<{ page: number; page_size: number; versions: Record<string, string[]> }>('/admin/sources/versions'),
  reload: (code: string) => request<PluginInfo>(`/admin/sources/${code}/reload`, { method: 'POST' }),
  rollback: (code: string) => request<PluginInfo>(`/admin/sources/${code}/rollback`, { method: 'POST' }),
  disable: (code: string) => request<{ code: string; state: string }>(`/admin/sources/${code}/disable`, { method: 'POST' }),
  unload: (code: string) => request<{ code: string; state: string }>(`/admin/sources/${code}/unload`, { method: 'POST' }),
  reloadAll: () => request<PluginInfo[]>('/admin/sources/reload-all', { method: 'POST' }),
}

export const monitorApi = {
  history: (q: { page?: number; pageSize?: number; source?: string; action?: string; pluginVersion?: string; inBandCode?: string; mediaType?: string; keyword?: string }) =>
    request<CallLogPage>('/admin/monitor/history', {
      query: {
        page: q.page ?? 1,
        page_size: q.pageSize ?? 20,
        source: q.source,
        action: q.action,
        plugin_version: q.pluginVersion,
        in_band_code: q.inBandCode,
        media_type: q.mediaType,
        keyword: q.keyword,
      },
    }),
}
