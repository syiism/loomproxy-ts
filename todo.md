# TS 版未实现清单（按建议顺序）

> 口径：**面板里已经有页/有按钮**、而后端在这条 TS 迁移线上还没接的，一律列在这里。
> 未接的端点现在回 `501 + 一句人话`（`notWired()`），不返回成功空响应——
> **做完一项就把那一项从这里删掉**，并把对应 501 占位换成真实实现 + 用例。
> 完成顺序按"对面板可用性的影响 / 依赖关系"排，不按表格好看程度排。

## A. 立即可做（无新表、只靠已有数据）

| # | 缺口 | 端点 | 依赖 |
|---|---|---|---|
| A5 | 设备与密钥统计 | `GET /admin/devices` | sessions / api_keys 已有 |
| A6 | 登录限频读数与解锁 | `GET/POST /admin/security/attempts` | 内存计数器（登录入口要接同一个） |

## B. 需要新表

| # | 缺口 | 端点 | 新表 |
|---|---|---|---|
| B1 | IP 拉黑 | `GET/POST /admin/blocked-ips`、`DELETE /:id` | `blocked_ips`（并接线到数据面/登录） |
| B2 | 套餐级接口限速（覆盖全局） | `GET/PUT/POST /admin/quota-costs/plans*` | `quota_cost_plans`（并接线到限流） |
| B3 | 额度转移 | `GET/POST/DELETE /quota/transfers*`、admin 代转 | `quota_transfer_logs` + 双源事务 |
| B4 | 卡密 | `GET/POST /admin/redeem-codes*`、`POST /user/redeem` | `redeem_codes` + 兑换事务 |
| B5 | 数据源分组（视图 + 批量操作） | `/admin/source-groups*` | `source_groups` + `group_id` 列 + 看板分节 |
| B6 | 数据源定时启停 | `/admin/source-schedules*` | `source_schedules` + 维护协程 |

## C. 结构性缺口（不是一两个端点能收的）

| # | 缺口 | 说明 |
|---|---|---|
| C1 | 号池运行时 | `GET /admin/pools` 恒回 `[]`：`source-kit` 有状态机，但没接设备表/维护协程 |
| C2 | 命名缓存与名称回填 | `POST /admin/monitor/backfill-subjects` 501；明细里书名/章节名靠源填 |
| C3 | 服务端渲染报表 | `GET /admin/monitor/report.html` 目前是一句占位 |
| C4 | worker 隔离模式 | 插件 manifest 支持 `isolation:"worker"`，宿主只实现了 in-process |
| C5 | socket activation 零停机 | 现在直接 `app.listen`；Go 版靠 systemd 传 fd |
| C6 | 面板其余域的门禁化 | Go 版有 nav-check/css-check 等 20 道门禁，本仓只有分层检查 |

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
