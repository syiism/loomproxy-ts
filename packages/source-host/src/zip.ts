// 极简 ZIP 读取器：只认「stored(0) / deflate(8)」两种压缩方式，不做 ZIP64、不做加密。
//
// 为什么自己写而不是加依赖：面板上传的是**插件包**（manifest + 入口 + data/*.json），
// 一个解压库为这点事引入供应链面不值；而 zip 的**读取**面很小——EOCD + 中央目录 +
// 本地头的偏移。反过来，**写** zip 才麻烦，所以生产路径不写、只在用例里写。
//
// 安全：这里只负责"把字节解成名字与内容"，**不判路径是否合法**——那条判据只有一处
// （host 的 safeRelPath）。两处各判一次就是两份事实，早晚一边松。
import { inflateRawSync } from 'node:zlib'

export type ZipLimits = {
  maxEntries: number
  maxEntryBytes: number
  maxTotalBytes: number
}

/** 上限的意义：压缩炸弹（1KB 解出 1GB）与"一次传一个有 10 万条目的包" */
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 512,
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
}

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const ZIP64_MARK = 0xffffffff

function u16(b: Uint8Array, at: number): number {
  return (b[at] as number) | ((b[at + 1] as number) << 8)
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at] as number) | ((b[at + 1] as number) << 8) | ((b[at + 2] as number) << 16) | ((b[at + 3] as number) << 24)) >>> 0
}

function findEocd(bytes: Uint8Array): number {
  // EOCD 在文件尾部，最大 22 + 65535（注释）字节
  const from = Math.max(0, bytes.length - 22 - 0xffff)
  for (let i = bytes.length - 22; i >= from; i--) if (u32(bytes, i) === EOCD_SIG) return i
  throw new Error('不是合法的 zip：找不到目录结尾（EOCD）')
}

/**
 * 解出「条目名 → 内容」。目录条目（以 / 结尾）与 macOS 的 `__MACOSX/` 垃圾直接跳过。
 * 文件名按 UTF-8 解（zip 的通用标志位 0x800 只影响"是否 UTF-8"，现代打包器一律 UTF-8）。
 */
export function readZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Map<string, Uint8Array> {
  const eocd = findEocd(bytes)
  const entries = u16(bytes, eocd + 10)
  const cdOffset = u32(bytes, eocd + 16)
  if (entries > limits.maxEntries) throw new Error(`zip 条目过多：${entries} > ${limits.maxEntries}`)

  const out = new Map<string, Uint8Array>()
  let total = 0
  let at = cdOffset
  for (let i = 0; i < entries; i++) {
    if (u32(bytes, at) !== CD_SIG) throw new Error('zip 中央目录损坏')
    const flags = u16(bytes, at + 8)
    const method = u16(bytes, at + 10)
    const csize = u32(bytes, at + 20)
    const usize = u32(bytes, at + 24)
    const nameLen = u16(bytes, at + 28)
    const extraLen = u16(bytes, at + 30)
    const commentLen = u16(bytes, at + 32)
    const localOffset = u32(bytes, at + 42)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen))
    at += 46 + nameLen + extraLen + commentLen

    if ((flags & 0x1) !== 0) throw new Error(`zip 条目已加密，拒绝：${name}`)
    if (method !== 0 && method !== 8) throw new Error(`不支持的压缩方式 ${method}（只认 stored/deflate）：${name}`)
    if (csize === ZIP64_MARK || usize === ZIP64_MARK) throw new Error(`不支持 ZIP64：${name}`)
    if (name.endsWith('/')) continue // 目录条目
    // macOS 打包垃圾（资源分支）直接忽略；**不要**用"以 . 开头"当判据——
    // 那会把 `../x` 这类穿越路径一起吞掉，于是 policy 层根本没机会拒绝它（静默丢弃比报错更坏）
    const base = name.slice(name.lastIndexOf('/') + 1)
    if (name.startsWith('__MACOSX/') || (base.startsWith('._') && base !== '.') || base === '.DS_Store') continue

    if (u32(bytes, localOffset) !== LOCAL_SIG) throw new Error(`zip 本地头损坏：${name}`)
    const dataStart = localOffset + 30 + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28)
    const raw = bytes.subarray(dataStart, dataStart + csize)
    const content = method === 0 ? raw : new Uint8Array(inflateRawSync(raw))
    if (content.length !== usize) throw new Error(`zip 条目长度不符（声明 ${usize}，实得 ${content.length}）：${name}`)
    if (content.length > limits.maxEntryBytes) throw new Error(`单个文件过大：${name}（${content.length} 字节）`)
    total += content.length
    if (total > limits.maxTotalBytes) throw new Error(`解压总量过大：> ${limits.maxTotalBytes} 字节`)
    if (out.has(name)) throw new Error(`zip 里有同名条目：${name}`)
    out.set(name, content)
  }
  return out
}