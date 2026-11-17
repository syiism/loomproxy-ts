// 声明位（迁移-TS-2 §2）：字段形状与 Go 版 SourceMeta 逐字对齐；值域校验挪进 zod。
// **形状不变**是"前端与下游不改"的前提，任何改名都要先改契约页并对拍。
import { z } from 'zod'
import { MEDIA } from './media.ts'

export const searchTabSchema = z
  .object({
    tab_type: z.number().int(),
    bd_id: z.string(),
    name: z.string(),
    media_type: z.enum(MEDIA).optional(),
  })
  .strict()

export type SearchTab = z.infer<typeof searchTabSchema>

/** 设置类型五档：是行为声明不是标签（面板写入端与声明位校验必须读同一份） */
export const SETTING_TYPES = ['string', 'bool', 'number', 'json', 'json_object'] as const
export type SettingType = (typeof SETTING_TYPES)[number]

export function isValidSettingType(t: string): t is SettingType {
  return (SETTING_TYPES as readonly string[]).includes(t)
}

export const settingDeclSchema = z
  .object({
    key: z.string().min(1),
    type: z.enum(SETTING_TYPES),
    default: z.string(),
    description: z.string(),
    sensitive: z.boolean().optional(),
  })
  .strict()

export type SettingDecl = z.infer<typeof settingDeclSchema>

export const dataFileDescSchema = z.object({ name: z.string().min(1), description: z.string() }).strict()
export type DataFileDesc = z.infer<typeof dataFileDescSchema>

/** 动作集：平台不做书源特例分支，动作由源自己声明 */
export const ACTION_NAMES = ['search', 'detail', 'chapter', 'content', 'explore'] as const
export type ActionName = (typeof ACTION_NAMES)[number]

export const sourceMetaSchema = z
  .object({
    code: z.string().regex(/^[a-z0-9_]+$/, 'code 只允许小写字母/数字/下划线'),
    display: z.string().min(1),
    category: z.string().min(1),
    description: z.string().optional(),
    sort_order: z.number().int().default(0),
    status: z.number().int().min(0).max(1).default(1),
    actions: z.array(z.enum(ACTION_NAMES)).min(1),
    required_params: z.record(z.array(z.string().min(1))).optional(),
    fixed_base_url: z.boolean().default(false),
    search_tabs: z.array(searchTabSchema).optional(),
    legacy_groups: z.array(z.string()).optional(),
    data_files: z.array(dataFileDescSchema).optional(),
    media_type: z.enum(MEDIA).optional(),
    settings: z.array(settingDeclSchema).optional(),
  })
  .strict()

export type SourceMeta = z.infer<typeof sourceMetaSchema>

/** 注册期禁用形态：非法即失败，不许降级成 warn（"带病装配不如启动失败"） */
export function parseSourceMeta(raw: unknown): SourceMeta {
  const m = sourceMetaSchema.parse(raw)
  if (m.media_type !== undefined && !m.media_type) {
    throw new Error(`数据源 ${m.code} 的 media_type 非法`)
  }
  const declared = new Set(m.actions)
  for (const [action, params] of Object.entries(m.required_params ?? {})) {
    if (!declared.has(action as ActionName)) {
      throw new Error(`数据源 ${m.code} 的 required_params 声明了未声明的动作 ${action}`)
    }
    if (params.some((p) => p.startsWith('_'))) {
      throw new Error(`数据源 ${m.code} 的 required_params 使用了平台保留前缀 _`)
    }
  }
  return m
}
