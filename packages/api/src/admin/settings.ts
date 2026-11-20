// 管理面 · 设置域：平台设置、个人数据源地址、导入配置。

import type { FastifyInstance } from 'fastify'
import { fail, ok } from '@loomproxy/contract'
import { resolveIdentity } from '../auth.ts'
import type { AdminContext } from './shared.ts'

export function registerSettingsRoutes(app: FastifyInstance, deps: AdminContext): void {
  const { config, stores, guard, unavailable } = deps

  // ---- 设置 ----
  app.get('/admin/settings', async (req, reply) => {
    if (!(await guard(req, reply))) return
    // 形状与 Go 的 ListSettings 一致：**items**（不是 list）+ sensitive_keys；
    // 源声明位里的设置项带上 source/source_display，面板据此把它们归到各自的源卡片。
    const rows = stores.settings?.list() ?? []
    const declared = new Map<string, { code: string; display: string }>()
    for (const entry of deps.host?.registryRef.list() ?? []) {
      for (const decl of entry.meta.settings ?? []) declared.set(decl.key, { code: entry.code, display: entry.meta.display })
    }
    const items = rows.map((r) => {
      const src = declared.get(r.key)
      return {
        ...r,
        ...(src ? { source: src.code, source_display: src.display } : {}),
      }
    })
    return ok({ items, sensitive_keys: stores.settings?.sensitiveKeys() ?? [] })
  })
  app.post('/admin/settings', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { key?: string; value?: string; type?: string; description?: string; sensitive?: boolean }
    if (!b.key || !b.type) {
      reply.code(400).send(fail(config.errorCode, '缺少 key 或 type'))
      return
    }
    const settings = stores.settings as unknown as { upsertRaw?: (i: { key: string; value: string; type: string; description: string; sensitive?: boolean }) => void }
    if (!settings?.upsertRaw) return unavailable(reply, '设置存储未接')
    try {
      settings.upsertRaw({ key: b.key, value: b.value ?? '', type: b.type, description: b.description ?? '', sensitive: !!b.sensitive })
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : '写入失败'))
      return
    }
    return ok({})
  })
  app.put('/admin/settings/:key', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { key } = req.params as { key: string }
    const b = (req.body ?? {}) as { value?: string }
    try {
      stores.settings?.set(key, b.value ?? '')
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : '写入失败'))
      return
    }
    return ok({})
  })
  app.delete('/admin/settings/:key', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { key } = req.params as { key: string }
    const settings = stores.settings as unknown as { remove?: (k: string) => boolean }
    settings?.remove?.(key)
    return ok({})
  })

  // ---- 个人数据源地址 ----
  app.get('/user/source-configs', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const cfg = stores.sourceConfigs
    if (!cfg) return unavailable(reply, '数据源默认地址存储未接')
    const user = stores.users?.byId(id.userId)
    const isAdmin = id.roles.includes('admin')
    const mine = cfg.user(id.userId)
    const items = (deps.dataSources?.listEnabled() ?? [])
      .filter((ds) => isAdmin || (stores.quota ? stores.quota.hasGrant(user?.plan_id ?? null, ds.name) : false))
      .map((ds) => ({ source_name: ds.name, source_display: ds.display_name, base_url: mine[ds.name] ?? '' }))
    return ok(items)
  })
  app.put('/user/source-configs', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const cfg = stores.sourceConfigs
    if (!cfg) return unavailable(reply, '数据源默认地址存储未接')
    const b = (req.body ?? {}) as { configs?: Array<{ source_name?: string; base_url?: string }> }
    for (const c of b.configs ?? []) {
      if (!c.source_name) continue
      cfg.setUser(id.userId, c.source_name, (c.base_url ?? '').trim())
    }
    return ok({})
  })

  // 导入入口：书源文件是否托管就位（就位才在面板显示提示；rc 路径与 Go 版同形）
  app.get('/user/import-config', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const rel = '/data/shuyuan/bookSource.json'
    const ready = existsSync(join(config.dataDir, 'shuyuan', 'bookSource.json'))
    return ok({ book_source_path: rel, ready })
  })
}
