// 优雅停机注册表（替代 Go 的 ticker-stop-check）：所有清理都从这里走，
// SIGTERM 时统一 abort，超时才算完。谁开的定时器谁在这里登记。
export type Cleanup = () => void | Promise<void>

export class ShutdownRegistry {
  private readonly cleanups: Cleanup[] = []
  private stopping = false

  register(fn: Cleanup): () => void {
    this.cleanups.push(fn)
    return () => {
      const i = this.cleanups.indexOf(fn)
      if (i >= 0) this.cleanups.splice(i, 1)
    }
  }

  async run(timeoutMs = 15_000): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    const tasks = this.cleanups.splice(0).map(async (fn) => {
      try {
        await fn()
      } catch (e) {
        // 清理失败不阻塞停机，但要出声
        // biome-ignore lint/suspicious/noConsole: 停机路径没有 logger 依赖
        console.error('cleanup failed:', e instanceof Error ? e.message : e)
      }
    })
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.all(tasks),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
    if (timer) clearTimeout(timer)
  }

  get isStopping(): boolean {
    return this.stopping
  }
}

export function installSignalHandlers(reg: ShutdownRegistry, onDone: () => void): void {
  const handler = () => {
    void reg.run().then(onDone)
  }
  process.once('SIGTERM', handler)
  process.once('SIGINT', handler)
}
