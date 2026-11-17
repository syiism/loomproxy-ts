# TS 版未实现清单

**当前为空。** 面板/协议/持久化/额度/号池/插件隔离这一条迁移线上，已没有"面板有页而后端未接"或
"设计页写了而实现缺席"的项。

> 口径（保留下来给下一次用）：**面板里已经有页/有按钮、而后端还没接的，一律先列在这里**；
> 未接的端点回 `501 + 一句人话`（`notWired()`），**不许返回成功空响应**；做完一项就删一项，
> 并把对应 501 占位换成真实实现 + 用例。

## 已收口（按收口顺序）

### 契约与插件
- ④ §7 三条：插件管理端点、明细 `plugin_version` 列、面板「源插件」页
- 面板—后端契约门禁 `tools/check-web-contract.mjs`（面板 78 个调用点对后端 94 条路由）
- panel 原样复用（原 Go 项目 `web/`，只补 api 方法/路由/导航三处 + 一个新页面）

### 持久化
- SQLite（`node:sqlite`，零 native）：users/roles/user_roles/sessions/api_keys/system_settings/
  data_sources/plans/api_call_logs/api_call_stats/quota_limits/user_quota_overrides/
  quota_usage_logs/quota_costs/quota_cost_plans/quota_transfer_logs/redeem_codes/source_groups/
  source_schedules/platform_source_configs/user_source_configs/pool_devices/name_cache/kv_state/blocked_ips
- 内置系统设置 29 条（对齐 Go `db/seed.go`，含废弃键清理）
- 管理员口令来源标记（`generated`/`env`/`panel`）+ `ADMIN_PASSWORD_SYNC`

### 额度与治理
- 限额即授权、批量授权/复制、用户覆盖、日界刷新、成功记账（去重）、超额 429
- 看板（Go `DashboardResponse` 全形状）、我的流水、admin 流水、接口成本表与套餐级限速
- 额度转移（双源事务 + 软删清除 + admin 代转）、卡密（生成/作废/批量/兑换换套餐）
- IP 拉黑（登录/数据面/注册三处共用）、登录限频（8 连错或 1 分钟 >10 次锁 15 分钟）、
  设备与密钥读数

### 运营
- 数据源分组（CRUD/成员/批量授权/看板分节）、定时启停（daily/once + 60s 维护协程）
- 调用趋势、服务端渲染报表 `report.html`、命名缓存 + 回填
- 号池运行时 `packages/pool`（墙钟/摊薄两形态、冷热/耗尽/死号/冷却、钩子带截止、快照脱敏），
  fq_novel 的会话池已接入（spread 型 + pinned 会话）
- 插件 worker 隔离：manifest `isolation:"worker"` → 独立线程执行；取数/设置/池走主线程桥
  （缓存/熔断/代理仍是一份），换代先 drain 再 terminate

### 运行面
- systemd socket activation（`LISTEN_FDS`/`LISTEN_PID`，拿不到回退自绑）
