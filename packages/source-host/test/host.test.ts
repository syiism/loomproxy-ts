import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, silentLogger, Upstream } from '@loomproxy/kernel'
import { SourceRegistry } from '@loomproxy/source-kit'
import { InMemoryDataSources, InMemorySettings } from '@loomproxy/store'
import { SourceHost, sdkCompatible } from '../src/index.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')

const created: Array<{ dispose(): Promise<void> }> = []
after(async () => {
  // worker 插件是真实线程：用例结束不收，Test runner 会等它们退出（表现为整个文件卡住）
  for (const h of created) await h.dispose()
})

function makeHost(pluginDir: string, drainTimeoutMs = 2_000) {
  const config = loadConfig({})
  const logger = silentLogger()
  const registry = new SourceRegistry()
  const settings = new InMemorySettings()
  const dataSources = new InMemoryDataSources()
  const upstream = new Upstream({ config, logger })
  const host = new SourceHost({ pluginDir, logger, registry, settings, dataSources, upstream, drainTimeoutMs })
  created.push(host)
  return { host, registry, settings, dataSources }
}

function tmpPlugins(extra: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'loomproxy-plugins-'))
  // worker 夹具会起真实线程：只在需要它的用例里拷（否则临时目录一删，worker 的 import 就变成未处理拒绝）
  for (const name of ['ok_one', 'ok_one_v1', 'bad_manifest', 'bad_sdk', 'throws', ...extra]) {
    cpSync(join(FIXTURES, name), join(dir, name), { recursive: true })
  }
  return dir
}

test('SDK 兼容：只认主版本（SDK 2 的插件不被 1.x 宿主接受）', () => {
  assert.equal(sdkCompatible('^2', 2), true)
  assert.equal(sdkCompatible('2.x', 2), true)
  assert.equal(sdkCompatible('^1', 2), false)
  assert.equal(sdkCompatible('^9', 2), false)
})

test('扫描：好插件 active，坏 manifest / 坏 sdk / 导入抛错各留 failed 记录且不拖垮别人', async () => {
  const dir = tmpPlugins()
  try {
    const { host, dataSources, settings } = makeHost(dir)
    const infos = await host.scanSync()
    const byCode = new Map(infos.map((i) => [i.code, i]))

    const ok = byCode.get('ok_one')
    assert.equal(ok?.state, 'active')
    assert.equal(ok?.version, '1.1.0', '单版本目录：manifest 里的 version')
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

test('外部换目录 + reload：多版本由外部管理，服务只认当前这一份', async () => {
  const dir = tmpPlugins()
  try {
    const v2 = join(dir, 'ok_one_v2')
    cpSync(join(dir, 'ok_one'), v2, { recursive: true })
    const { host, registry } = makeHost(dir)
    await host.scanSync()
    const before = registry.resolve('ok_one', 'content')
    const body1 = (await before!.handler({ params: {}, settings: {} as never } as never)) as { data: { content: string } }
    assert.equal(body1.data.content, 'v2 body')

    // 外部用 v1 目录原子替换当前目录，再让服务 reload
    rmSync(join(dir, 'ok_one'), { recursive: true, force: true })
    cpSync(join(dir, 'ok_one_v1'), join(dir, 'ok_one'), { recursive: true })
    const info = await host.reload('ok_one')
    assert.equal(info.version, '1.0.0')
    const after = registry.resolve('ok_one', 'content')
    const body2 = (await after!.handler({ params: {}, settings: {} as never } as never)) as { data: { content: string } }
    assert.equal(body2.data.content, 'v1 body')

    // 外部换回 v2 再 reload
    rmSync(join(dir, 'ok_one'), { recursive: true, force: true })
    cpSync(v2, join(dir, 'ok_one'), { recursive: true })
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

    // 外部替换目录时塞了坏 manifest：reload 失败但老代继续服务
    const good = readFileSync(join(dir, 'ok_one', 'manifest.json'), 'utf8')
    writeFileSync(join(dir, 'ok_one', 'manifest.json'), JSON.stringify({ sdk_version: '^2', version: '9.9.9', entry: './index.mjs' }))
    await assert.rejects(() => host.reload('ok_one'))
    assert.equal(registry.get('ok_one')?.version, '1.1.0', '老代仍在服务')
    assert.equal(registry.get('ok_one')?.state, 'active')
    const info = host.info().find((i) => i.code === 'ok_one')
    assert.match(info?.last_error ?? '', /manifest|meta|actions/i)
    writeFileSync(join(dir, 'ok_one', 'manifest.json'), good)
    assert.equal((await host.reload('ok_one')).version, '1.1.0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('drain：换代等问题身上的在飞请求走完（在飞期间不换指针）', async () => {
  const dir = tmpPlugins()
  try {
    const { host, registry } = makeHost(dir, 3_000)
    await host.scanSync()
    // 外部换成 v1 目录，reload 才是一次"真换代"
    rmSync(join(dir, 'ok_one'), { recursive: true, force: true })
    cpSync(join(dir, 'ok_one_v1'), join(dir, 'ok_one'), { recursive: true })
    assert.equal(registry.get('ok_one')?.version, '1.1.0')

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
    assert.equal(registry.get('ok_one')?.version, '1.0.0')
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

test('worker 隔离：插件跑在独立线程里，宿主按 invoke 调用并能换代/卸载', async () => {
  const dir = tmpPlugins(['worker_one'])
  try {
    const { host, registry } = makeHost(dir)
    const infos = await host.scanSync()
    const w = infos.find((i) => i.code === 'worker_one')
    assert.equal(w?.state, 'active')
    assert.equal(w?.isolation, 'worker')

    const entry = registry.get('worker_one')
    assert.ok(entry?.invoke, 'worker 插件走 invoke，不把 handler 拿回主线程')
    const result = (await entry!.invoke!('search' as never, { key: 'abc' } as never)) as {
      bookList: Array<{ name: string }>
    }
    assert.equal(result.bookList[0]?.name, 'worker 搜到：abc')

    // 换代：reload 后仍可用（老 worker 被 drain + terminate）
    const info = await host.reload('worker_one')
    assert.equal(info.state, 'active')
    const again = (await registry.get('worker_one')!.invoke!('search' as never, { key: 'xyz' } as never)) as {
      bookList: Array<{ name: string }>
    }
    assert.equal(again.bookList[0]?.name, 'worker 搜到：xyz')

    // 卸载：注册表摘干净 + 线程收掉（先 dispose 再删临时目录，否则 worker 的 import 会炸在删除之后）
    await host.unload('worker_one')
    assert.equal(registry.get('worker_one'), undefined)
    await host.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('worker 里的源也能读到自己的敏感设置（快照不许用面板视角的抹值列表）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomproxy-worker-settings-'))
  try {
    const v = join(dir, 'worker_cfg')
    mkdirSync(v, { recursive: true })
    writeFileSync(
      join(v, 'manifest.json'),
      JSON.stringify({
        sdk_version: '^2',
        version: '1.0.0',
        isolation: 'worker',
        entry: './index.mjs',
        params: { search: ['key'] },
        meta: {
          code: 'worker_cfg',
          display: 'W2',
          category: 'fixture',
          actions: ['search'],
          settings: [{ key: 'w_secret', type: 'string', default: 'from-manifest', description: '密钥', sensitive: true }],
        },
      }),
    )
    writeFileSync(
      join(v, 'index.mjs'),
      `export default (sdk) => ({ handlers: { search: async (ctx) => ({ bookList: [], secret: ctx.settings.get('w_secret') }) } })`,
    )
    const { host, registry, settings } = makeHost(dir)
    const infos = await host.scanSync()
    assert.equal(infos.find((i) => i.code === 'worker_cfg')?.state, 'active')
    assert.equal(settings.get('w_secret'), 'from-manifest', '主线程侧能读到真值')

    const result = (await registry.get('worker_cfg')!.invoke!('search' as never, { key: 'x' } as never)) as {
      secret?: string
    }
    assert.equal(result.secret, 'from-manifest', 'worker 侧拿到的快照也必须含敏感键真值')
    await host.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('worker 的取数走主线程桥：worker 里没有自己的 undici，缓存/熔断仍是一份', async () => {
  // 主线程起一个极小上游，worker 里的 handler 用 ctx.fetch.text 拉它
  const { createServer } = await import('node:http')
  let hits = 0
  const server = createServer((_req, res) => {
    hits++
    res.setHeader('content-type', 'text/plain')
    res.end(`hello-${hits}`)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port

  const dir = mkdtempSync(join(tmpdir(), 'loomproxy-worker-bridge-'))
  const v = join(dir, 'worker_fetch')
  mkdirSync(v, { recursive: true })
  writeFileSync(
    join(v, 'manifest.json'),
    JSON.stringify({
      sdk_version: '^2',
      version: '1.0.0',
      isolation: 'worker',
      entry: './index.mjs',
      params: { search: ['key'] },
      meta: { code: 'worker_fetch', display: 'W', category: 'fixture', actions: ['search'] },
    }),
  )
  writeFileSync(
    join(v, 'index.mjs'),
    `export default (sdk) => ({ handlers: { search: async (ctx) => {
       const body = await ctx.fetch.text(ctx.params.key, {});
       return { bookList: [{ bookId: 'x', name: body, author: '', kind: '', wordCount: '', lastChapter: '', intro: '', coverUrl: '' }] };
     } } })`,
  )

  try {
    const { host, registry } = makeHost(dir)
    await host.scanSync()
    const invoke = registry.get('worker_fetch')?.invoke
    assert.ok(invoke, 'worker 插件走 invoke')
    const one = (await invoke('search' as never, { key: `http://127.0.0.1:${port}/a` } as never)) as {
      bookList: Array<{ name: string }>
    }
    assert.equal(one.bookList[0]?.name, 'hello-1', '上游由主线程执行，结果回传 worker')
    assert.equal(hits, 1)
    await host.dispose()
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('世代与加载次数是两件事：generation 是全局序号（跨源单调），loads 才是这个源的加载次数', async () => {
  const dir = tmpPlugins(['worker_one'])
  try {
    const { host } = makeHost(dir)
    const first = await host.scanSync()
    const byCode = new Map(first.map((i) => [i.code, i]))
    const ok = byCode.get('ok_one')!
    const bad = byCode.get('bad_manifest')!
    // 同时加载两个源：世代号不同（全局唯一，才能区分"在飞请求属于哪一代"）
    assert.notEqual(ok.generation, bad.generation)
    assert.equal(ok.loads, 1)
    assert.equal(bad.loads, 0, '加载失败不算一次加载')

    // 只 reload ok_one：它的 generation 前进、loads+1；别的源两格都不动
    await host.reload('ok_one')
    const after = new Map(host.info().map((i) => [i.code, i]))
    assert.ok(after.get('ok_one')!.generation > ok.generation)
    assert.equal(after.get('ok_one')!.loads, 2)
    assert.equal(after.get('bad_manifest')!.generation, bad.generation)
    await host.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
