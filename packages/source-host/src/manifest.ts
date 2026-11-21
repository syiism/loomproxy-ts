// manifest 校验：插件目录里的 manifest.json 就是声明位（迁移-TS-4 §3）。
// SDK 2 起服务只认单版本：plugins/<code>/ 下直接是 manifest.json，不再有 <version>/ 子目录；
// 多版本由开发者/发布系统在外部维护（换目录 → reload），这里只校验"当前这一份"。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pluginManifestSchema, type PluginManifest } from '@loomproxy/contract'

export type PluginDir = {
  code: string
  version: string
  dir: string
  entry: string
  manifest: PluginManifest
}

/** sdk_version 只校验主版本：`^2` / `2.x` / `2.0.0` 都接受 2.x 宿主 */
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

export function describePlugin(codeDir: string): PluginDir {
  const manifest = readManifest(codeDir)
  return {
    code: manifest.meta.code,
    version: manifest.version,
    dir: codeDir,
    entry: join(codeDir, manifest.entry),
    manifest,
  }
}
