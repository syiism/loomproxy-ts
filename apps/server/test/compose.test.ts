// e2e：走"线上同一条装配路径"（compose），不起端口、用 inject。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { silentLogger } from '@loomproxy/kernel'
import { compose } from '../src/compose.ts'

test('装配：没有插件目录也能起（/datasources 为空），有插件则立即可派发', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loomproxy-compose-'))
  try {
    const empty = await compose({
      env: { PLUGIN_DIR: join(root, 'plugins'), DATA_DIR: join(root, 'data') },
      logger: silentLogger(),
    })
    const emptyRes = await empty.app.inject({ method: 'GET', url: '/datasources' })
    assert.deepEqual((emptyRes.json() as { data: unknown[] }).data, [])
    await empty.app.close()

    // 放一个插件进去，重新装配即可用（等价于进程启动时那段扫描）
    const v = join(root, 'plugins', 'p_one', '1.0.0')
    mkdirSync(v, { recursive: true })
    writeFileSync(
      join(v, 'manifest.json'),
      JSON.stringify({
        sdk_version: '^1',
        entry: './index.mjs',
        meta: { code: 'p_one', display: 'P1', category: 'p', actions: ['search'] },
      }),
    )
    writeFileSync(
      join(v, 'index.mjs'),
      `export default { handlers: { search: async () => ({ bookList: [{ bookId: '1', name: 'n', author: 'a', kind: 'k', wordCount: '', lastChapter: '', intro: '', coverUrl: '' }] }) } }`,
    )

    const { app, settings, dataSources } = await compose({
      env: { PLUGIN_DIR: join(root, 'plugins'), DATA_DIR: join(root, 'data') },
      logger: silentLogger(),
    })
    const res = await app.inject({ method: 'GET', url: '/p_one/search?key=x' })
    assert.equal(res.statusCode, 200)
    assert.equal((res.json() as { bookList: unknown[] }).bookList.length, 1)
    assert.equal(dataSources.get('p_one')?.status, 1)
    assert.equal(settings.get('missing_key'), '')
    await app.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
