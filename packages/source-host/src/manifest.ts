// manifest 校验：插件目录里的 manifest.json 就是声明位（迁移-TS-4 §3）。
// 校验不过 = 拒绝加载并保留老代；不许"尽力加载"。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pluginManifestSchema, type PluginManifest } from '@loomproxy/contract'

export type PluginVersionDir = {
  code: string
  version: string
  dir: string
  entry: string
  manifest: PluginManifest
}

/** 语义化版本比较（够用即可：只比数字段，预发布后缀按字符串兜底） */
export function compareVersion(a: string, b: string): number {
  const pa = a.split(/[.\-+]/)
  const pb = b.split(/[.\-+]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = Number(x)
    const ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny
      continue
    }
    if (x !== y) return x.localeCompare(y)
  }
  return 0
}

/** sdk_version 只校验主版本：`^1` / `1.x` / `1.0.0` 都接受 1.x 宿主 */
export function sdkCompatible(range: string, sdkMajor: number): boolean {
  const m = /(\d+)/.exec(range)
  if (!m) return false
  return Number(m[1]) === sdkMajor
}

export function readManifest(dir: string): PluginManifest {
  const p = join(dir, 'manifest.json')
  if (!existsSync(p)) throw new Error(`缺少 manifest.json: ${p}`)
  const raw: unknown = JSON.parse(readFileSync(p, 'utf8'))
  return pluginManifestSchema.parse(raw)
}

/** 扫一个插件的版本目录（<pluginDir>/<code>/<version>/） */
export function listVersions(pluginCodeDir: string): string[] {
  return readdirSync(pluginCodeDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => /^\d+\.\d+/.test(n))
    .sort(compareVersion)
}

export function describeVersion(pluginCodeDir: string, version: string): PluginVersionDir {
  const dir = join(pluginCodeDir, version)
  const manifest = readManifest(dir)
  return { code: manifest.meta.code, version, dir, entry: join(dir, manifest.entry), manifest }
}
