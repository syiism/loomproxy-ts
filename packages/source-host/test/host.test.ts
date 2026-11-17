import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, silentLogger, Upstream } from '@loomproxy/kernel'
import { SourceRegistry } from '@loomproxy/source-kit'
import { InMemoryDataSources, InMemorySettings } from '@loomproxy/store'
import { SourceHost, compareVersion, sdkCompatible } from '../src/index.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')

function makeHost(pluginDir: string, drainTimeoutMs = 2_000) {
  const config = loadConfig({})
  const logger = silentLogger()
  const registry = new SourceRegistry()
  const settings = new InMemorySettings()
  const dataSources = new InMemoryDataSources()
  const upstream = new Upstream({ config, logger })
  const host = new SourceHost({ pluginDir, logger, registry, settings, dataSources, upstream, drainTimeoutMs })
  return { host, registry, settings, dataSources }
}

function tmpPlugins(): string {
  const dir = mkdtempSync(join(tmpdir(), 'loomproxy-plugins-'))
  for (const name of ['ok_one', 'bad_manifest', 'bad_sdk', 'throws']) {
    cpSync(join(FIXTURES, name), join(dir, name), { recursive: true })
  }
  return dir
}

test('版本比较与 SDK 兼容：只认主版本', () => {
  assert.ok(compareVersion('1.0.0', '1.1.0') < 0)
  assert.ok(compareVersion('1.10.0', '1.9.0') > 0)
  assert.equal(compareVersion('1.0.0', '1.0.0'), 0)
  assert.equal(sdkCompatible('^1', 1), true)
  assert.equal(sdkCompatible('^9', 1), false)
})

test('扫描：好插件 active，坏 manifest / 坏 sdk / 导入抛错各留 failed 记录且不拖垮别人', async () => {
  const dir = tmpPlugins()
  try {
    const { host, dataSources, settings } = makeHost(dir)
    const infos = await host.scanSync()
    const byCode = new Map(infos.map((i) => [i.code, i]))

    const ok = byCode.get('ok_one')
    assert.equal(ok?.state, 'active')
    assert.equal(ok?.version, '1.1.0', '默认加载最新版本')
    assert.equal(dataSources.get('ok_one')?.display_name, '夹具一号')
    assert.equal(settings.get('fixture_mode'), 'v2', '声明位里的设置项在加载时落行')

    assert.equal(byCode.get('bad_manifest')?.state, 'failed')
    assert.match(byCode.get('bad_manifest')?.last_error ?? '', /actions|manifest/i)
    assert.equal(byCode.get('bad_sdk')?.state, 'failed')
    assert.match(byCode.get('bad_sdk')?.last_error ?? '', /sdk_version/)
    assert.equal(byCode.get('throws')?.state, 'failed')
    assert.match(byCode.get('throws')?.last_error ?? '', /boom/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('回滚：版本指针回到上一代，正文随之变化（进程不重启）', async () => {
  const dir = tmpPlugins()
  try {
    const { host, registry } = makeHost(dir)
    await host.scanSync()
    const before = registry.resolve('ok_one', 'content')
    const body1 = (await before!.handler({ params: {}, settings: {} as never } as never)) as { data: { content: string } }
    assert.equal(body1.data.content, 'v2 body')

    const info = await host.rollback('ok_one')
    assert.equal(info.version, '1.0.0')
    const after = registry.resolve('ok_one', 'content')
    const body2 = (await after!.handler({ params: {}, settings: {} as never } as never)) as { data: { content: string } }
    assert.equal(body2.data.content, 'v1 body')

    // reload 回到最新
    const back = await host.reload('ok_one')
    assert.equal(back.version, '1.1.0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('坏版本不顶掉老代：reload 失败保留当前版本并记 last_error', async () => {
  const dir = tmpPlugins()
  try {
    const { host, registry } = makeHost(dir)
    await host.scanSync()
    assert.equal(registry.get('ok_one')?.version, '1.1.0')

    // 新版本 manifest 非法
    mkdirSync(join(dir, 'ok_one', '1.2.0'), { recursive: true })
    writeFileSync(join(dir, 'ok_one', '1.2.0', 'manifest.json'), JSON.stringify({ sdk_version: '^1', entry: './x.mjs' }))
    writeFileSync(join(dir, 'ok_one', '1.2.0', 'x.mjs'), 'export default { handlers: { search: async () => ({ bookList: [] }) } }')

    await assert.rejects(() => host.reload('ok_one'))
    assert.equal(registry.get('ok_one')?.version, '1.1.0', '老代仍在服务')
    assert.equal(registry.get('ok_one')?.state, 'active')
    const info = host.info().find((i) => i.code === 'ok_one')
    assert.match(info?.last_error ?? '', /manifest|meta|actions/i)
    // 回滚仍指向上一代
    const rb = await host.rollback('ok_one')
    assert.equal(rb.version, '1.0.0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('drain：换代等问题身上的在飞请求走完（在飞期间不换指针）', async () => {
  const dir = tmpPlugins()
  try {
    const { host, registry } = makeHost(dir, 3_000)
    await host.scanSync()
    await host.rollback('ok_one') // 先退到 1.0.0，这样 reload 才是"真换代"
    assert.equal(registry.get('ok_one')?.version, '1.0.0')

    host.begin('ok_one') // 模拟一个还在这代上的请求
    const started = Date.now()
    let finished = false
    const p = host.reload('ok_one').then(() => {
      finished = true
    })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(finished, false, '在飞请求没走完，换代不该结束')

    host.end('ok_one')
    await p
    assert.ok(Date.now() - started >= 100)
    assert.equal(registry.get('ok_one')?.version, '1.1.0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('卸载与禁用：禁用后派发 404，卸载后注册表没有它', async () => {
  const dir = tmpPlugins()
  try {
    const { host, registry } = makeHost(dir)
    await host.scanSync()
    host.disable('ok_one')
    assert.equal(registry.resolve('ok_one', 'search'), undefined)
    await host.unload('ok_one')
    assert.equal(registry.get('ok_one'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
