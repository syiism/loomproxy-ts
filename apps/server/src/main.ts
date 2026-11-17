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
  const { config, app, host, schedules, pools } = await compose()
  mkdirSync(config.dataDir, { recursive: true })

  const shutdown = new ShutdownRegistry()
  shutdown.register(() => pools.stopAll())
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

  // 数据源定时启停：每 60 秒一拍（到点启用、窗口外的一次性规则收尾）
  const schedTimer = setInterval(() => {
    try {
      schedules.evaluate(config.tzOffsetHours)
    } catch (e) {
      console.error('[schedules] 巡检失败:', e instanceof Error ? e.message : e)
    }
  }, 60_000)
  schedTimer.unref?.()
  shutdown.register(() => clearInterval(schedTimer))

  installSignalHandlers(shutdown, () => process.exit(0))

  // systemd socket activation（与 Go 版同语义）：端口由 systemd 持有，进程从 LISTEN_FDS 接过 fd。
  // 拿去不到就回退自建监听——本地开发与非 systemd 部署行为完全一致。
  const activated = ((): number | undefined => {
    if (process.env['LISTEN_FDS'] !== '1') return undefined
    const pid = Number(process.env['LISTEN_PID'] ?? 0)
    if (pid !== 0 && pid !== process.pid) return undefined
    return 3 // 单个 socket 的 fd 恒为 3（SD_LISTEN_FDS_START）
  })()
  if (activated !== undefined) {
    await app.ready()
    // Fastify 的 listen 不接 fd：直接把底层 http.Server 挂到继承来的 fd 上
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject)
      app.server.listen(activated, () => resolve())
    })
    console.log('[loomproxy] listening on systemd-activated fd（面板 /panel）')
  } else {
    await app.listen({ host: config.serverHost, port: config.serverPort })
    console.log(`[loomproxy] listening on ${config.serverHost}:${config.serverPort}（面板 /panel）`)
  }
}

main().catch((e: unknown) => {
  console.error('启动失败:', e instanceof Error ? e.message : e)
  process.exit(1)
})
