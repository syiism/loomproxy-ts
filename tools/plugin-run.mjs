#!/usr/bin/env node
// 单插件跑通工具（对应 ③ §5 的"源层可单独跑通"）：
//   node tools/plugin-run.mjs <code> <action> [key=value ...]
// 不起 host、不连 DB，只把 manifest + 入口 + 一个真实取数门面接起来，打印 DTO。
// 用途：改源时 1 秒看结果，不必起服务、不必走面板。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig, createLogger, Upstream } from '../packages/kernel/src/index.ts'
import { createFetchFacade } from '../packages/source-kit/src/index.ts'
import { pluginManifestSchema } from '../packages/contract/src/index.ts'

const [code, action, ...kv] = process.argv.slice(2)
if (!code || !action) {
  console.error('用法: node tools/plugin-run.mjs <code> <action> [key=value ...]')
  process.exit(2)
}

const root = new URL('..', import.meta.url).pathname
const dir = join(root, 'packages', 'plugins', code)
const manifestPath = join(dir, 'manifest.json')
if (!existsSync(manifestPath)) {
  console.error(`没有这个插件: ${dir}`)
  process.exit(2)
}
const manifest = pluginManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
const entry = join(dir, manifest.entry.replace(/^\.\//, '').replace(/^index\.mjs$/, 'src/index.ts'))
const mod = await import(pathToFileURL(existsSync(entry) ? entry : join(dir, 'src', 'index.ts')).href)
const def = mod.default
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
// manifest 里声明的标准集之外也允许显式传（这里只是开发探针，不是路由）

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

// 大正文只打前 200 字，其它字段原样
const shown =
  result && typeof result === 'object' && result.data && typeof result.data.content === 'string' && result.data.content.length > 200
    ? { ...result, data: { ...result.data, content: result.data.content.slice(0, 200) + `…（共 ${result.data.content.length} 字）` } }
    : result
console.log(JSON.stringify(shown, null, 2))
console.error(`[plugin-run] ${code}/${action} ${ms}ms`)
