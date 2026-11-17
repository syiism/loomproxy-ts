# TS 版未实现清单（按建议顺序）

> 口径：**面板里已经有页/有按钮**、而后端在这条 TS 迁移线上还没接的，一律列在这里。
> 未接的端点现在回 `501 + 一句人话`（`notWired()`），不返回成功空响应——
> **做完一项就把那一项从这里删掉**，并把对应 501 占位换成真实实现 + 用例。
> 完成顺序按"对面板可用性的影响 / 依赖关系"排，不按表格好看程度排。

## B. 需要新表

（B 组已全部完成）

## C. 结构性缺口（不是一两个端点能收的）

（C1 号池运行时已完成：`packages/pool` + fq_novel 的会话池接入）

| # | 缺口 | 说明 |
|---|---|---|
| C4 | worker 隔离模式 | 插件 manifest 支持 `isolation:"worker"`，宿主只实现了 in-process；需要 RPC 取数通道（④ §8） |

## 已完成（供对照，不再列在上面）

- ④ §7 三条：插件管理端点、`plugin_version` 明细列、面板「源插件」页
- 数据库读写（SQLite）：用户/角色/套餐/会话/密钥/设置/数据源/明细/聚合
- 额度域：限额即授权、批量授权/复制、用户覆盖、日界刷新、成功记账（去重）、超额 429、
  看板（`/quota/dashboard` 按 Go 的 DashboardResponse 形状）、我的流水、admin 流水、接口成本表
- **A1** 调用趋势 `GET /admin/monitor/trend`（按天 × 源聚合，读明细）
- **A2** 个人数据源默认地址 `GET/PUT /user/source-configs`（表 `user_source_configs`，非管理员按套餐授权过滤）
- **A3** 导入入口 `GET /user/import-config`（书源文件在位判定，与 Go 同形）
- **A4** 平台数据源默认地址 `GET/PUT /admin/source-configs`（表 `platform_source_configs`）
- 面板额度卡片渲染修复：`/quota/dashboard` 之前漏了 `sources/groups/is_admin/plan_name/next_reset/...`
  这些格（面板读 `data.sources`，空数组 ⇒ 整页显示"暂无额度配置"），并修了 `next_reset` 的时区显示（曾显示 16:00）
- **A5** 设备与密钥读数 `GET /admin/devices`（会话/密钥/明细 IP 按用户聚合，`suspect` 标红判据同 Go）
- **A6** 登录限频 `GET/POST /admin/security/attempts` + 登录入口接线（8 次连错或 1 分钟 >10 次锁 15 分钟）
- **B1** IP 拉黑 `blocked_ips` + 三处共用判定（登录/数据面/注册）
- **B2** 套餐级接口限速 `quota_cost_plans`（覆盖全局），dispatch 每次现取 `套餐 → 全局 → 不限`
- **B3** 额度转移 `quota_transfer_logs`（双源事务、覆盖增量、软删清除、admin 代转）
- **B4** 卡密 `redeem_codes`（生成/作废/批量作废/兑换换套餐，同一事务）
- **B5** 数据源分组 `source_groups` + `data_sources.group_id`（CRUD/成员/批量授权/看板分节）
- **C3** 服务端渲染报表 `GET /admin/monitor/report.html`（读聚合表，一次生成整页 HTML）
- **C5** systemd socket activation（`LISTEN_FDS`/`LISTEN_PID` → 继承 fd 监听，拿不到回退自绑）
- **B6** 数据源定时启停 `source_schedules`（daily 钟点 / once 绝对时刻；`in_window`/`window_text`/`applied` 现算，
  main.ts 每 60s 一拍，停机时 clear）
- **C2** 命名缓存 `name_cache` + 回填（`POST /admin/monitor/backfill-subjects` 返回 books/chapters 补了多少行）
- **C1** 号池运行时 `packages/pool`（墙钟/摊薄两种形态、冷热/耗尽/死号/冷却、钩子带截止、快照脱敏）+
  `DeviceStore` 端口声明在 contract、实现在 store（单向依赖）；fq_novel 用 `defineSource({ pool })`
  接成会话池（spread 型，建号走 device_register，取号后写 pinned 会话文件给协议层）
- **C6** 面板—后端契约门禁 `tools/check-web-contract.mjs`（扫 `web/src/api/index.js` 的调用点对后端路由表，
  已进 `pnpm run check`；模板字面量路由按通配段匹配）——对应 Go 版 nav-check 那一族
