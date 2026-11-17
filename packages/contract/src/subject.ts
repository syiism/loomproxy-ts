// 观测的内容维度（迁移-TS-2 §8）：空串 = 没抽到，不是错误。
import type { MediaOrEmpty } from './media.ts'

export const SUBJECT_FIELD_MAX = { keyword: 128, bookName: 160, chapterTitle: 255 } as const

export type CallSubject = {
  keyword: string
  book_name: string
  chapter_title: string
  media: MediaOrEmpty
  result_count: number
  in_band_error: boolean
  in_band_reason: string
  in_band_code: string
  /** 内部标识：只用于查命名缓存，不对外暴露 */
  book_key: string
  chapter_key: string
  /** 内容维度是**被本人关掉的**，不是没抽到：两个"全空"必须分得开 */
  content_withheld: boolean
}

export function newSubject(): CallSubject {
  return {
    keyword: '',
    book_name: '',
    chapter_title: '',
    media: '',
    result_count: 0,
    in_band_error: false,
    in_band_reason: '',
    in_band_code: '',
    book_key: '',
    chapter_key: '',
    content_withheld: false,
  }
}

/** 按 rune 截断（不是 byte）：中文按 byte 截会截出半个字 */
function clip(s: string, max: number): string {
  const arr = [...s]
  return arr.length <= max ? s : arr.slice(0, max).join('')
}

export function clipSubject(s: CallSubject): CallSubject {
  return {
    ...s,
    keyword: clip(s.keyword, SUBJECT_FIELD_MAX.keyword),
    book_name: clip(s.book_name, SUBJECT_FIELD_MAX.bookName),
    chapter_title: clip(s.chapter_title, SUBJECT_FIELD_MAX.chapterTitle),
  }
}

/**
 * 用户不同意留存时抹掉全部内容维度。标识必须一起清：名称回填循环按标识反查补写，
 * 留着标识等于"当场说不捕获、下一轮被自己补回来"。
 * in_band_* 保留：它说的是这次请求成没成，不是用户读了什么。
 */
export function withholdContent(s: CallSubject): CallSubject {
  return {
    ...s,
    keyword: '',
    book_name: '',
    chapter_title: '',
    media: '',
    result_count: 0,
    book_key: '',
    chapter_key: '',
    content_withheld: true,
  }
}
