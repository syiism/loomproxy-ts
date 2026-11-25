// 插件目录的内容指纹：判断一次 reload 是"真换了代码"还是仅仅被 watcher/手动触发。
// 只按路径 + 文件字节算，touch 改 mtime 不算变化；软链与安装暂存目录不算插件代码。
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function pluginFingerprint(dir: string): string {
  const hash = createHash('sha256')
  const walk = (rel: string): void => {
    const abs = rel === '' ? dir : join(dir, rel)
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.')) // .staging-* / .backup-* / 编辑器临时文件
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        walk(child)
        continue
      }
      // 软链指向目录外的文件，不该算进插件自身的 hash（本仓也禁止插件带软链）
      if (!e.isFile()) continue
      hash.update(child).update('\0')
      hash.update(readFileSync(join(dir, child)))
      hash.update('\0')
    }
  }
  walk('')
  return hash.digest('hex')
}
