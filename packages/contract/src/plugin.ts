// 插件元信息（迁移-TS-4 §3）：SourceMeta 之外的几格，决定怎么加载、能不能加载。
import { z } from 'zod'
import { sourceMetaSchema } from './source-meta.ts'

// SDK 2：插件只做类型导入，运行时 helper 由宿主注入；插件目录不再自带 SDK/zod，也没有服务内多版本目录。
export const SDK_VERSION = '2.0.0'
export const SDK_RANGE = '^2'

/** in-process = 默认（热更新靠缓存破坏导入）；worker = 隔离（CPU 重活/第三方插件） */
export const ISOLATIONS = ['in-process', 'worker'] as const
export type Isolation = (typeof ISOLATIONS)[number]

export const pluginManifestSchema = z
  .object({
    sdk_version: z.string().regex(/^[\^~]?\d+(\.\d+)*$/),
    /** 插件版本：多版本由开发者/发布系统外部维护，服务只认当前目录这一份 */
    version: z.string().regex(/^\d+\.\d+(\.\d+)?([-.][0-9A-Za-z.]+)*$/),
    isolation: z.enum(ISOLATIONS).default('in-process'),
    entry: z.string().min(1),
    /**
     * 每个动作注入哪些 query（对应 Go 版 Handler.GetQueryParams）：
     * 缺省 = 该动作的标准参数集（见 ACTION_DEFAULT_PARAMS），源要用非标准参数必须显式声明。
     */
    params: z.record(z.array(z.string().min(1))).optional(),
    /** 可选：加载自检用的 fixture 名（host 只记录，不自行解释） */
    self_check: z.string().optional(),
    meta: sourceMetaSchema,
  })
  .strict()

export type PluginManifest = z.infer<typeof pluginManifestSchema>

/** 动作的标准参数集：source 不声明 params 时按这张表注入（与下游书源的默认动作对齐） */
export const ACTION_DEFAULT_PARAMS = {
  search: ['key', 'query', 'page'],
  detail: ['bookId'],
  chapter: ['bookId', 'page'],
  content: ['bookId', 'itemId'],
  explore: ['url', 'category', 'page'],
} as const satisfies Record<ActionName, readonly string[]>

import type { ActionName } from './source-meta.ts'
