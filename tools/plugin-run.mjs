#!/usr/bin/env node
// 单插件跑通工具（对应 ③ §5 的"源层可单独跑通"）：
//   node tools/plugin-run.mjs <code> <action> [key=value ...]
// 不起 host、不连 DB，只把 manifest + 入口 + 一个真实取数门面接起来，打印 DTO。
// 用途：改源时 1 秒看结果，不必起服务、不必走面板。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
const codeDir = join(root, 'plugins', code)
const version = readdirSync(codeDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^\d+\.\d+/.test(e.name))
  .map((e) => e.name)
  .sort((a, b) => Number(b.split('.')[0]) - Number(a.split('.')[0]) || Number(b.split('.')[1]) - Number(a.split('.')[1]))[0]
const dir = version ? join(codeDir, version) : ''
if (!dir || !existsSync(join(dir, 'manifest.json'))) {
  console.error(`没有这个插件的版本目录: ${codeDir}/<version>`)
  process.exit(2)
}
const manifest = pluginManifestSchema.parse(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))
const mod = await import(pathToFileURL(join(dir, manifest.entry)).href)
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
