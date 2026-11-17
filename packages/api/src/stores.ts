// 路由用到的存储集合：**全部可选**——缺哪个就把依赖它的端点回 501（不假造成功）。
// 这样同一套路由能同时服务"内存骨架"与"接库"两种装配，用例也不必把整库拖进来。
import type {
  ApiKeyStore,
  DbQuota,
  CallLogStore,
  DataSourceStore,
  PlanStore,
  RoleStore,
  SessionStore,
  SettingsStore,
  DbUsers,
} from '@loomproxy/store'

export type ApiStores = {
  users?: DbUsers
  roles?: RoleStore
  plans?: PlanStore
  sessions?: SessionStore
  apiKeys?: ApiKeyStore
  settings?: SettingsStore
  dataSources?: DataSourceStore & { listAll?(): unknown[]; create?(...args: never[]): unknown }
  callLogs?: CallLogStore
  quota?: DbQuota
}

/** 未接的后端域：回 501 + 一句人能照着做的话（面板会把 msg 原样 toast 出来） */
export function notWired(msg: string): { status: 501; msg: string } {
  return { status: 501, msg: `${msg}（本 TS 部署尚未迁移这一块）` }
}
