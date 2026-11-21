#!/usr/bin/env node
// 单插件跑通工具（SDK 2：源码即插件，单版本目录）：
//   node tools/plugin-run.mjs <code> <action> [key=value ...]
// 不起 host、不连 DB，只把 manifest + 入口 + 宿主注入的 SDK/取数门面接起来，打印 DTO。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig, createLogger, Upstream } from '../packages/kernel/src/index.ts'
import { createFetchFacade, createPluginSdk } from '../packages/source-kit/src/index.ts'
import { pluginManifestSchema } from '../packages/contract/src/index.ts'

const [code, action, ...kv] = process.argv.slice(2)
if (!code || !action) {
  console.error('用法: node tools/plugin-run.mjs <code> <action> [key=value ...]')
  process.exit(2)
}

const root = new URL('..', import.meta.url).pathname
const dir = join(root, 'plugins', code)
if (!existsSync(join(dir, 'manifest.json'))) {
  console.error(`没有这个插件: ${dir}/manifest.json`)
  process.exit(2)
}
const manifest = pluginManifestSchema.parse(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))
const mod = await import(pathToFileURL(join(dir, manifest.entry)).href)
if (typeof mod.default !== 'function') {
  console.error('插件入口必须 export default (sdk) => ({ handlers })（SDK 2）')
  process.exit(2)
}
const def = mod.default(createPluginSdk())
if (!def?.handlers?.[action]) {
  console.error(`插件 ${code} 没有动作 ${action}；可用: ${Object.keys(def?.handlers ?? {}).join(' / ')}`)
  process.exit(2)
}

const params = {}
for (const pair of kv) {
  const i = pair.indexOf('=')
  if (i <= 0) continue
  params[pair.slice(0, i)] = pair.slice(i + 1)
}

const config = loadConfig(process.env)
const logger = createLogger(config.serverLogLevel === 'debug' ? 'debug' : 'info', 'plugin')
const upstream = new Upstream({ config, logger })
const settings = { get: () => '', getBool: (_k, d) => d, getInt: (_k, d) => d }

const started = Date.now()
const result = await def.handlers[action]({
  source: code,
  action,
  params,
  signal: new AbortController().signal,
  fetch: createFetchFacade(upstream),
  settings,
})
const ms = Date.now() - started

const shown =
  result && typeof result === 'object' && result.data && typeof result.data.content === 'string' && result.data.content.length > 200
    ? { ...result, data: { ...result.data, content: result.data.content.slice(0, 200) + `…（共 ${result.data.content.length} 字）` } }
    : result
console.log(JSON.stringify(shown, null, 2))
console.error(`[plugin-run] ${code}/${action} ${ms}ms`)
