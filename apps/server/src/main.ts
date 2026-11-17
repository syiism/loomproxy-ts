// 进程入口：只做"读 env → 装配 → 监听 → 停机"，业务都在 packages 里。
import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs'
import { join } from 'node:path'
import { ShutdownRegistry, installSignalHandlers, parseDotEnv } from '@loomproxy/kernel'
import { compose } from './compose.ts'

function loadEnv(cwd = process.cwd()): void {
  const p = join(cwd, '.env')
  if (!existsSync(p)) return
  const merged = parseDotEnv(readFileSync(p, 'utf8'), process.env)
  for (const [k, v] of Object.entries(merged)) process.env[k] = v
}

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: NodeJS.Timeout | undefined
  return ((...args: never[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
    timer.unref?.()
  }) as T
}

async function main(): Promise<void> {
  loadEnv()
  const { config, app, host } = await compose()
  mkdirSync(config.dataDir, { recursive: true })

  const shutdown = new ShutdownRegistry()
  shutdown.register(() => app.close())

  // 热更新：插件目录里文件变化 → 只 reload 受影响的那个 code，进程不重启
  const reloadOne = debounce((code: string) => {
    void host
      .reload(code)
      .then((i) => console.log(`[host] 热更新 ${i.code}@${i.version} 生效`))
      .catch((e: unknown) => console.error(`[host] 热更新 ${code} 失败（保留老代）: ${e instanceof Error ? e.message : e}`))
  }, 300)

  if (existsSync(config.pluginDir)) {
    const stopWatch = watch(config.pluginDir, { recursive: true }, (_ev, file) => {
      if (!file) return
      const code = file.split(/[\\/]/)[0]
      if (code) reloadOne(code as never)
    })
    shutdown.register(() => stopWatch.close())
  }

  installSignalHandlers(shutdown, () => process.exit(0))
  await app.listen({ host: config.serverHost, port: config.serverPort })
  console.log(`[loomproxy] listening on ${config.serverHost}:${config.serverPort}`)
}

main().catch((e: unknown) => {
  console.error('启动失败:', e instanceof Error ? e.message : e)
  process.exit(1)
})
