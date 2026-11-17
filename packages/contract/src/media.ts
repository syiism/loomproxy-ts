// 媒介枚举与归一：平台口径，源与监控共用（见 docs/方案/迁移-TS-2-base字段协议.md §2.1）
// 空串 = 未判定，是合法状态，不许用默认值把它抹平。
export const MEDIA = ['novel', 'audio', 'comic', 'video'] as const
export type Media = (typeof MEDIA)[number]
export type MediaOrEmpty = Media | ''

export function isValidMedia(v: string): v is Media {
  return (MEDIA as readonly string[]).includes(v)
}

// Legado 的 bookTypeCode：0/4=小说、1=漫画、2=音频、3=视频，其余空
export function mediaFromBookTypeCode(code: number): MediaOrEmpty {
  switch (code) {
    case 0:
    case 4:
      return 'novel'
    case 1:
      return 'comic'
    case 2:
      return 'audio'
    case 3:
      return 'video'
    default:
      return ''
  }
}

// 响应自带的 contentType：既认 Legado 规范词，也认本仓既有写法（novel/manga）
export function mediaFromContentType(contentType: string): MediaOrEmpty {
  const s = contentType.trim().toLowerCase()
  if (s === 'audio' || s === 'video' || s === 'comic') return s
  if (s === 'manga' || s === 'image') return 'comic'
  if (s === 'text' || s === 'novel') return 'novel'
  return ''
}

const LABEL: Record<Media, string> = { novel: '小说', audio: '音频', comic: '漫画', video: '视频' }
export function mediaLabel(media: MediaOrEmpty): string {
  return isValidMedia(media) ? LABEL[media] : '未判定'
}
