// 五动作 DTO（迁移-TS-2 §4）。字段名与 JSON 键序按 Go 结构体原样，改名即破坏下游。
// **空值语义**：omitempty 的字段用 undefined（不是 null）——JSON.stringify 会跳过 undefined。
import { z } from 'zod'

const str = z.string()

export const bookItemSchema = z
  .object({
    bookId: str,
    name: str,
    author: str,
    kind: str, // 首项 = 数据源码（平台出口统一打标，源填了也会被覆盖）
    wordCount: str,
    lastChapter: str,
    intro: str,
    coverUrl: str,
    bookType: str.optional(),
    // 指针语义：缺失 ≠ 0（0 也是 novel）。TS 用 undefined 表达"缺失"。
    bookTypeCode: z.number().int().optional(),
    source: str.optional(),
  })
  .strict()

export type BookItem = z.infer<typeof bookItemSchema>

export const searchResponseSchema = z
  .object({
    bookList: z.array(bookItemSchema),
    sources_status: z.record(z.string()).optional(),
  })
  .strict()

export type SearchResponse = z.infer<typeof searchResponseSchema>

export const bookDetailSchema = z
  .object({
    bookType: str,
    bookTypeCode: z.number().int(),
    authorId: str,
    bookId: str,
    name: str,
    aliasName: str,
    author: str,
    status: str,
    createTime: str,
    lastUpdateTime: str,
    wordCount: str,
    category: str,
    tags: str,
    roles: str,
    tones: str,
    score: str,
    readCount: str,
    source: str,
    intro: str,
    copyright: str,
    bookReview: str,
    coverUrl: str,
    lastChapter: str,
  })
  .strict()

export type BookDetail = z.infer<typeof bookDetailSchema>

export const chapterItemSchema = z
  .object({ title: str, itemId: str, chapterInfo: str, isVip: z.boolean() })
  .strict()

export const chapterResponseSchema = z
  .object({
    chapterList: z.array(chapterItemSchema),
    nextTocUrl: str.optional(),
  })
  .strict()

export type ChapterResponse = z.infer<typeof chapterResponseSchema>

/** contentType 的合法来源三处：Legado 规范词 / 本仓既有写法 / error（= 空媒介） */
export const contentResponseSchema = z
  .object({
    contentType: str,
    data: z.record(z.unknown()),
  })
  .strict()

export type ContentResponse = z.infer<typeof contentResponseSchema>

export const exploreResponseSchema = z.object({ bookList: z.array(bookItemSchema) }).strict()
export type ExploreResponse = z.infer<typeof exploreResponseSchema>

/** 正文的三种常规形状（源构造时用，避免各源手写 data 字典） */
export function textContent(content: string, extra: Record<string, unknown> = {}): ContentResponse {
  return { contentType: 'novel', data: { content, ...extra } }
}

export function audioContent(url: string, extra: Record<string, unknown> = {}): ContentResponse {
  return { contentType: 'audio', data: { content: url, ...extra } }
}

export function inBandError(message: string, extra: Record<string, unknown> = {}): ContentResponse {
  return { contentType: 'error', data: { message, ...extra } }
}
