# loomproxy-ts — LoomProxy 的 Node/TypeScript 重写分支

> 这是**孤儿分支** `ts/main` 的工作树：只有方案页与 TS 实现，**没有任何 Go 代码**
> （`tools/check-layers.mjs` 里有这条规则，出现 `.go` 文件当场红）。
> Go 版仍是现网正本，在本分支里只作为"行为对拍的 oracle"（读，不改）。

## 这是什么

- `docs/方案/迁移-TS-1-接口契约.md`：对外 HTTP 面冻结清单（前端与下游不用改的那一面）
- `docs/方案/迁移-TS-2-base字段协议.md`：声明位 / 五动作 DTO / 取数 / 号池 / 观测 / 配置的逐字段正本
- `docs/方案/迁移-TS-3-漏斗分层与包边界.md`：六层单向依赖、每层单独跑通判据、门禁换血
- `docs/方案/迁移-TS-4-源插件与热更新.md`：源做成插件包（不重启加/换/回滚源）

这几页原写在骨架仓（`loomproxy-base/docs/方案/`），跨链指向的 `docs/架构/*`、`docs/规范/*`
仍在骨架仓里——本分支只带走"要落地这份实现"所需的部分。

## 目录（漏斗式，只许向下依赖）

```
packages/contract   L0  线上形状 + 声明位 + 枚举 + zod schema（纯类型，零 IO）
packages/kernel     L1  配置/日志/时钟/缓存/合并/熔断/取数栈/停机
packages/store      L2  设置项与数据源行（当前内存+JSON 实现，drizzle 版见 ③ §6）
packages/source-kit L2′ 源作者 SDK + 插件 manifest schema + 注册表 + 观测抽取
packages/gate       L3  访问判定 / 计费 / 限流
packages/source-host L3 插件宿主：扫描 / manifest 校验 / 换代 / drain / 回滚
packages/api        L4′ Fastify 装配：控制面路由 + /:source/:action 派发
packages/plugins/*  L4  源包（一源一包）：manifest.json + src/index.ts，只依赖 contract/kernel/source-kit
apps/server         L5  进程入口（compose → listen → 停机），装配顺序的唯一出处
web                 —  **原 Go 项目面板原样搬入**（Vue3 + Vite，7814 行），只补了「源插件」一页与
                      api 方法、monitor 的 plugin_version 筛选；产物 web/dist 由 server 托管
```

**已落地的源包**：`packages/plugins/fq_novel`（番茄小说，搜索/详情/目录/正文四动作，实网跑通）。

依赖矩阵与禁反向依赖的规则在 `tools/check-layers.mjs`（`pnpm check:layers`）。

## 命令

```bash
pnpm install
pnpm run check        # = 分层 + tsc + 面板构建 + 面板契约 + 全部用例
# 探针：GET /health   （裸对象 {app,status}）；面板在根路径 /（/panel 已退役，301 到同名干净路径）
pnpm run check:layers # 只看依赖方向（顺带断言树里没有 Go 代码）
pnpm run check:types  # tsc -p tsconfig.json（noEmit）
pnpm test             # 35 个用例，不连网、不连 DB
pnpm dev              # 起服务（读 .env，PLUGIN_DIR 默认 plugins/）

# 单插件跑通（不起服务、不连 DB；③ §5 的"源层可单独跑通"）
node tools/plugin-run.mjs fq_novel search query=三体
node tools/plugin-run.mjs fq_novel chapter bookId=6983938353934634020
node tools/plugin-run.mjs fq_novel content bookId=6983938353934634020 itemId=7476392329142602777

# 打包成运行期插件目录（plugins/<code>/<version>/，然后 host 就能扫到；产物已 gitignore）
node tools/pack-plugin.mjs fq_novel

# 面板
pnpm run check:web     # 构建面板（等价 pnpm -F @loomproxy/web build）
pnpm run dev:web       # 面板开发态（:5174，接口代理到 :8081）
```

Node 24 直接跑 `.ts`（type stripping），所以**用例不需要构建**；这也约束了写法：
不用 `enum`、`namespace`、构造器参数属性（strip-only 不支持）。`tsc` 只做类型检查。

## 本轮落地的切片（能跑通的那条竖线）

| 能力 | 状态 |
|---|---|
| 声明位 zod 校验、五动作 DTO、媒介/媒介码归一、omitempty→undefined | ✅ `packages/contract` |
| 配置（键与默认值对齐 Go 版）、`.env` 优先级、日志脱敏、LRU+TTL、singleflight、熔断、取数门面 | ✅ `packages/kernel` |
| 注册表换代原子性、"每次请求现取"、观测抽取、search 打标（照 `PrependSourceToKind`） | ✅ `packages/source-kit` |
| 插件扫描 / manifest+SDK 校验 / 加载失败不拖垮别人 / reload / rollback / drain / 卸载 | ✅ `packages/source-host` |
| 访问判定六档（顺序与 Go 一致）、双维限流、计费去重窗口 | ✅ `packages/gate` |
| `/`、`/datasources`、`/data*`、`/endpoints`、`/announcement`、`/admin/sources/*`、`/:source/:action` | ✅ `packages/api` |
| 插件目录 `fs.watch` → 只 reload 变动源（**不重启进程**） | ✅ `apps/server` |
| 面板：原 Go 面板全量搬入 + 「源插件」新页；登录/用户/角色/设置/数据源/监控/明细 已接真库 | ✅ `web` |
| 调用明细 `plugin_version` 列（④ §7 批准的那一格） | ✅ 出口 hook 记账 + `/admin/monitor/history` |
| 源包实现 | ✅ 试点 1 个：`fq_novel`（4 动作，实网跑通 search/detail/chapter/content）；其余源未开始 |
| **号池运行时** | ✅ `packages/pool`（墙钟/摊薄两形态、冷热/耗尽/死号/冷却、维护协程、快照脱敏）；fq_novel 的会话池已接入（spread 型，建号走 device_register，取号写 pinned 会话） |
| **数据库读写** | ✅ SQLite（`node:sqlite` 内置，无 native/cgo）：users/roles/user_roles/sessions/api_keys/system_settings/data_sources/plans/api_call_logs/api_call_stats/quota_limits/user_quota_overrides/quota_usage_logs/quota_costs，DDL 在 `packages/store/src/sqlite.ts` |
| **内置系统设置（29 条）** | ✅ 键/初值/类型/说明对齐 Go `db/seed.go`；**且真的生效**：`announcement`（/announcement 横幅）、`register_enabled`（注册开关）、`default_role`/`default_quota_plan`（新用户）、`email_domain_allowlist/blocklist`（后缀匹配，白名单优先）、`maintenance_mode`（数据面 503，管理员放行）、`verify_code_scenes`（/verify/config 下发场景）、`jwt_expire_hours`（登录有效期，-1 永不过期） |
| **额度域** | ✅ 限额即授权（scope=source）、批量授权/复制、用户覆盖、日界起算点刷新、成功记账（去重窗口）、超额 429、看板/我的流水/admin 流水、接口成本表 |
| drizzle/sqlite 持久化（设置、data_sources、明细、号池表） | ⛔ 未接（`store` 现为内存实现） |
| worker 隔离模式 | ✅ manifest `isolation:"worker"`：独立线程跑 handler，取数/设置/池经线协议回主线程（缓存/熔断/代理仍一份），换代先 drain 再 terminate |
| 额度**转移**（`/quota/transfer*`、admin 代转）、卡密、分组、定时、IP 拉黑、设备、套餐级接口限速（`quota_cost_plans`） | ⛔ 未接：显式 **501 + 一句人能照着做的话**（不是成功空响应）。面板照旧显示，报错原样 toast |
| drizzle / MySQL / PostgreSQL | ⛔ 本轮用 `node:sqlite` + 手写 DDL；接口不变，换 provider 时只动 `packages/store` |

## 外部依赖（fq_novel 试点）

`packages/plugins/fq_novel` **不自己实现签名/加密/会话池**，它把
`/home/muyang/work/novels/fanq`（维护者的番茄协议参考实现，ESM）当协议层动态 import：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `FQ_PROTOCOL_DIR` | `/home/muyang/work/novels/fanq` | 协议树位置；不在位时插件返回带内错误而不是崩 |
| `FQ_SESSION_POOL` | `DATA_DIR/_runtime/fq_novel/fq-sessions.json` | 设备会话池。首次运行从协议树拷一份种子（5 台已注册设备）；**刻意不放 `DATA_DIR/fq_novel/`**，否则 `/data` 会把它当成静态字典列出来 |
| `FQ_POOL_MAX` | `5` | 协议层自己的会话池上限 |

## JWT 互认（与 Go 版同一个 `JWT_SECRET` 时）

- **claims 同形**：`{uid, username, jti, iat, iss:"loomproxy", sub:"user", exp?}` —— 与本仓早期形状
  `{user_id, username, roles}` 不同，读的时候两个都兜着（旧票不会一夜失效）。
- **角色不进 token**：每次请求从库里读（Go 版同口径）。所以在面板改角色立刻生效，不用重新登录。
- **`exp` 可缺省**：Go 的 `JWT_EXPIRE_HOURS=-1` 就是不写 `exp`；本仓同样接受"无 exp"的票。
- **会话归属**：本库有这张 `jti` 就必须有效（撤销/禁用立刻失效）；本库没有（跨版本/跨库签发）按签名放行，
  并记进审计日志的入口——**别把"外来票放行"理解成"撤销无效"**，本库的票照样一撤就废。
- Cookie 名与 Go 版一致（`loomproxy_token`），`Authorization: Bearer`、`?token=`、Cookie 三种都认。

## 管理员口令（重启后 env 里的口令还算不算数）

`ADMIN_USERNAME` / `ADMIN_PASSWORD` 只在**创建**管理员时用；库里的哈希属于谁，由 `kv_state` 里
`admin_password_source:<名字>` 记着（`generated` / `env` / `panel`）：

| 上次来源 | 这次 env 有口令 | 启动行为 |
|---|---|---|
| 无（首启） | 无 | 随机生成并打印到启动日志（只出现这一次） |
| 无（首启） | 有 | 用 env 创建，标记 `env` |
| `generated` | 有 | **按 env 重置**（随机口令多半没人抄下来，env 是更好的来源） |
| `env` | 与库中一致 | 不动 |
| `env` | 与库中不一致 | 只告警（可能面板改过），不覆盖 |
| `panel`（面板改过） | 任意 | 以面板为准；要强制以 env 为准设 `ADMIN_PASSWORD_SYNC=true` |

另外启动日志会打印 `数据库 <路径>　管理员 <名字>`——**DB 路径是相对 cwd 的**（`DATA_DIR`/`DB_PATH`），
换目录启动等于换了一个库，症状是"怎么登都错"，先看这一行。

本插件只做两件事：调协议层的 4 个模块 + 把结果映射成 legado DTO（`src/normalize.ts` 是唯一"源专属知识"）。

**已知未接**（都在 ③④ 的设计里，属后续工作，不是缺陷）：
- kernel 的熔断/代理/上游缓存对 fq 协议层**不生效**（协议层自带重试与域名轮换）——
  这是"复用外部协议层"的过渡形态；自己实现协议层时才接回 `ctx.fetch`。
- `explore`（发现）未做：Go 版声明了，但上游 `cell/change` 实测只返回卡片模板。
- 协议层用全局 `fetch`，不接我们的 `AbortSignal`：客户端取消不会中断上游请求。

## 边界

- 插件 = 任意代码执行：只从本地受信目录加载，**不提供从 URL 安装**（④ §9）。
- 契约不许漂：数据面裸对象、控制面 `{code,msg,data}`、`/datasources` 字段名都与 Go 版逐字一致；
  双跑对拍方法见 ① §8。
