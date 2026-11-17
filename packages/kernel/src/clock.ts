// 时区与日界只有一处定义（对应 Go 的 tz-check 判据）：别在业务里裸用 Date 的 UTC 方法。
export type Clock = {
  now(): Date
  /** 平台"今天 0 点"的 UTC 毫秒时间戳（按配置的 TZ_OFFSET_HOURS） */
  startOfDay(now?: Date): number
  /** 距下一个日界还有多少毫秒 */
  msUntilNextDay(now?: Date): number
}

export function createClock(tzOffsetHours: number): Clock {
  const offsetMs = tzOffsetHours * 3600_000
  return {
    now: () => new Date(),
    startOfDay(now = new Date()) {
      const local = now.getTime() + offsetMs
      return Math.floor(local / 86_400_000) * 86_400_000 - offsetMs
    },
    msUntilNextDay(now = new Date()) {
      return this.startOfDay(now) + 86_400_000 - now.getTime()
    },
  }
}
