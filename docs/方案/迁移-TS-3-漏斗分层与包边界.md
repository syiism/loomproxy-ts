# 迁移 TS ③：漏斗分层与包边界

> 目标：把今天的"一个 Go module 里 30 个包互相引用"改成**漏斗式单向依赖** ——
> 最下面是核心（只含类型与运行时原语），每往上一层只**添加这一层需要的结构**，不重述下层、
> 也不把自己的类型泄漏回下层；每一层都能被单独跑通、单独测。
> 分层灵感与判据同 pi 的包结构：`pi-ai`（协议/模型）→ `pi-agent-core`（循环）→
> `pi-tui`/`pi-codemode`/`pi-mcp`（能力插件）→ `pi-coding-agent`（装配成 CLI），
> SDK 复用的正是同一套底层，而不是另起一份。
> 契约面见 [`迁移-TS-1-接口契约.md`](迁移-TS-1-接口契约.md)，字段协议见
> [`迁移-TS-2-base字段协议.md`](迁移-TS-2-base字段协议.md)，插件化（不重启加/换源）见
> [`迁移-TS-4-源插件与热更新.md`](迁移-TS-4-源插件与热更新.md)。

## 1. 三条规则（其余都是它们的结果）

1. **依赖只许向下**：`L(n)` 只能 import `L(<n)`。同一层之间不互相 import（除同族共享包，
   如 `fq` 协议层被 `fq_novel/fq_audio/...` 共享——那是"同层子包"，要显式登记例外）。
2. **上层只添加自己需要的结构**：`RouteEntry`（HTTP 视图）不出现在 `contract`；
   `AccessReason`（判定枚举）不出现在 `store`；`PlanSnapshot` 只属于 `gate`。
   判据：**只有跨层传递或跨进程传输的形状，才允许下沉到 `contract`**。
3. **下层不 import 上层，也不认识上层的概念**：`kernel` 里不许出现 `source`、`quota`、`route` 字样；
   它只认识"配置、日志、HTTP 客户端、缓存、超时、错误"。

配套一条铁律：**唯一的装配点是 `apps/server`**（composition root）。所有"注入"都发生在最顶层，
下层之间通过接口（port）被满足——但**接口声明在下层**（谁需要谁声明），实现在上层。

## 2. 六层（+1 个非 TS 层）

| 层 | 包名 | 一句话 | 允许依赖 |
|---|---|---|---|
| L0 | `@loomproxy/contract` | 线上形状 + 声明位 + 枚举 + zod schema（**纯类型，零 IO**） | `zod` |
| L1 | `@loomproxy/kernel` | 运行时原语：配置、日志、时钟/时区、缓存、singleflight、错误类、取数栈（undici + 熔断 + 代理池）、worker 池 | L0、node 内置、`undici` |
| L2 | `@loomproxy/store` | 持久化：SQLite（`node:sqlite`）+ 手写 DDL、settings/用户/会话/密钥/数据源/明细/聚合 | L0、L1 |
| L2′ | `@loomproxy/source-kit` | 源作者适配层：登记表、legado DTO 构造/校验、取数门面、声明位校验、观测回填、`defineSource()`，以及**插件 manifest schema** | L0、L1（**不依赖 store**） |
| L3 | `@loomproxy/gate` | 治理：access / billing / ratelimit / dedupe / plan / transfer / identity | L0、L1、L2 |
| L3 | `@loomproxy/source-host` | 插件宿主：目录扫描、manifest 校验、`import()` 换代、蓝绿 drain、运行期声明落地、注册表、worker RPC、回滚 | L0、L1、L2、L2′ |
| L4 | `plugins/*`（源码形态 `packages/source-<code>`） | 36 个源，一源一包；同族共享包 `source-fq-protocol` 等 | L0、L1、L2′（同族共享包） |
| L4′ | `@loomproxy/api` | HTTP 装配：Fastify 插件、中间件链、catalog/rank/quota/auth/verify/admin handlers | L0–L3（含 `source-host`）、L2′ |
| L5 | `apps/server` | 进程：读 env → 建 DB → OnBoot → 启动池 → 挂路由 → 监听（socket activation）→ 优雅停机 | 全部 |
| — | `web/` | Vue3 SPA（保持不变），产物 `dist/` 由 `apps/server` 在运行时读 | 无（不进 TS 依赖图） |

## 3. 依赖矩阵（机器化的那张表）

`✓` 允许、空 = 禁止（`dependency-cruiser` 就是照这张表生成规则的）。

| ↓依赖→ | contract | kernel | store | source-kit | gate | source-host | plugins | api | server |
|---|---|---|---|---|---|---|---|---|---|
| **contract** | — | | | | | | | | |
| **kernel** | ✓ | — | | | | | | | |
| **store** | ✓ | ✓ | — | | | | | | |
| **source-kit** | ✓ | ✓ | | — | | | | | |
| **gate** | ✓ | ✓ | ✓ | | — | | | | |
| **source-host** | ✓ | ✓ | ✓ | ✓ | | — | | | |
| **plugins** | ✓ | ✓ | | ✓ | | | 同族共享包 | | |
| **api** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | — | |
| **server** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |

两条特殊性（必须在规则里显式表达，否则会被当遗漏）：

- **`source-host` ↔ `plugins` 是运行期边，不是 import 边**：host 用 `import()` 加载插件目录，
  编译期两者不相识（这也正是“加源不用重编 host”的原因）。`dependency-cruiser` 看不见这条，
  所以**反向约束要靠 manifest 的 `sdk_version`**（④ §3）。
- **plugins 只许 import `source-kit`**，不许 import `store`/`gate`/`api`（否则插件一升级就要求平台同版本）。

三条容易踩的边界：

- `source-kit` **不 import `store`**。源要读设置项时拿的是注入的 `SettingsReader` 接口
  （声明在 source-kit，实现在 store）——这样"一个源 + 一份假设置"就能跑，不必起数据库。
- `api` 不 import 任何具体源包：源通过 `defineSource()` 在模块加载期自注册，
  `api` 只读登记表。**加源不改 `api`**（对应 Go 版 `deploy_all.go` 那个空白导入清单，
  TS 版变成 `plugins/<code>/<version>/` 一个目录，见 [`迁移-TS-4-源插件与热更新.md`](迁移-TS-4-源插件与热更新.md)）。
  **热更新之后 `api` 连“读登记表”也不直接做**，改成向 `source-host` 求当前代（每次请求现取，不闭包捕获）。
- `server` 是唯一知道"顺序"的地方：`config → db → settings seed → OnBoot → pool.startAll → routes → listen`。
  把它写进文档而不是散落在各包 init，是 ② §10 那张时序表的 TS 落点。

## 4. 现有代码的三处反向依赖（实测，迁移时要修掉）

用 `grep -rh '"loomproxy/...'` 逐目录量出来的，不是推测：

| 位置 | 现状 | 违反 | 修法 |
|---|---|---|---|
| `utils/auth.go`、`utils/apikey.go` → `loomproxy/db`、`loomproxy/models` | 凭证解析直接查库 | 原语层依赖持久化层 | 身份解析搬到 `gate/identity`；`utils` 只留 JWT 签名/校验、Token 提取等纯函数 |
| `base/pool/state.go`、`base/pool/status.go` → `loomproxy/db`、`loomproxy/models` | 池状态机自己落库 | 源适配层依赖持久化层 | 在 `source-kit` 声明 `DeviceStore` 端口（load/save/delete/list），`store` 实现，`server` 注入 |
| `base/legado/cache.go` → `loomproxy/conf` | TTL 直接读全局配置 | 属于 L1→L1（conf 就在 L1），**合规** | 不过度设计；保留"注入 `ttl()` 或读 config"两条都可以，但要单一出口 |

反例（好榜样，TS 版照抄）：`middleware` 根包**零 `loomproxy/*` 导入**（真叶子），
`models` 也是零导入。它们证明"叶子包"在这个仓里是可行的。

## 5. 每一层怎么单独跑通（DoD 各不相同）

| 层 | 跑通判据 | 命令（拟） | 需要的夹具 |
|---|---|---|---|
| L0 | `tsc -b` 通过 + zod 对每条 schema 做正/反例 roundtrip + 黄金 JSON 快照不漂 | `pnpm -F @loomproxy/contract test` | 来自 ① §8 的语料快照（字段层面） |
| L1 | 假 fetch（`undici.MockAgent`）+ 假时钟下：熔断开合、代理轮换、`headersKey` 与 Go 一致、`AbortSignal` 超时 | `pnpm -F @loomproxy/kernel test` | 无网络、无 DB |
| L2 | `:memory:` sqlite 全量迁移 + seed 幂等 + settings 敏感键只写不回显 | `pnpm -F @loomproxy/store test` | 一个空库 |
| L2′ | 语料回放：给定参数 + 假上游 → 产出与 Go 逐字节相同的 DTO | `pnpm -F @loomproxy/source-kit test` | 无 DB、无 HTTP（fetch 注入） |
| L3 | 内存表 + 假设置下，六种 `AccessReason`、额度扣减、去重窗口、双维限流全部命中 | `pnpm -F @loomproxy/gate test` | 内存 store |
| L3′ | `source-host`：假插件跑 load→swap→drain→rollback；坏 manifest / 坏 sdk_version / 导入抛错 三种失败各有用例 | `pnpm -F @loomproxy/source-host test` | fixture 插件 |
| L4（源） | 单源 smoketest：`plugin-run <code> search --fixture …` 输出合法 DTO（**不起 host、不碰 DB**） | `pnpm -F @loomproxy/source-fq_novel run smoke` | 该源自己的 fixture |
| L4′ | Fastify `inject()` 跑全部 47 个前端调用点 + 数据面五动作，不快照网络 | `pnpm -F @loomproxy/api test` | 假 store/gate |
| L5 | 真进程：`/datasources` 列全部携带源；双跑对拍 Go 全绿；**热更新 e2e**（reload×3 + rollback + 坏插件，全程不重启） | `pnpm -F @loomproxy/server e2e` | 现网语料 + 临时 sqlite + 两份插件版本目录 |

**"每层可单独跑通"的硬含义**：任何一层的 `test` 都不许连真实上游、不许连真实 MySQL/Redis、
不许依赖上一层先跑过。`api` 的测试用 `inject()`；`sources` 的测试用 fixture；
`gate` 的测试用内存 store。做不到这三条，说明依赖方向又漏了。

## 6. 目录映射（Go 今天 → TS 明天）

| 现有 Go | 去向 | 说明 |
|---|---|---|
| `models/` | L0 `contract/src/rows/` | 零导入的纯结构，正好当契约；drizzle 表定义在 L2 单独写 |
| `conf/` | L1 `kernel/src/config/` | 键→默认值唯一出口 |
| `utils/{jwt,network,norm,paging,device}.go` | L1 `kernel/src/` | 纯函数/加密/分页/网络 |
| `utils/{auth,apikey}.go` | L3 `gate/src/identity/` | 见 §4 第 1 行 |
| `utils/cache.go` | L1 `kernel/src/cache/` | LRU + Redis 适配器分开（Redis 适配器放 L2 也行，取决于是否要"无 DB 单跑"） |
| `base/*.go`（BaseHandler、registry、fetch、circuit、proxy、media、subject） | 拆两处：**取数/熔断/代理 → L1**；**registry/声明位/legado DTO/observe → L2′** | 这是本次拆分里最关键的一刀 |
| `base/legado/*` | L2′ `source-kit/src/legado/` | DTO + 五动作基类 + 观测回填 |
| `base/pool/*` | L2′ `source-kit/src/pool/`（状态机）+ L2 的 `DeviceStore` 实现 | 见 §4 第 2 行 |
| `db/` | L2 `store/src/` | `sqlite.ts`（DDL/迁移）+ `db-repos*.ts`（users/roles/plans/sessions/keys/settings/data_sources/call_logs）；seed 在 `apps/server/src/compose.ts` |
| `gate/` | L3 `gate/src/` | access/billing/ratelimit/dedupe/plan/transfer |
| `middleware/` | L1 的 `transport` 四条（requestid/recovery/logging/cors/cachecontrol）+ L3/L4′（apiauth/ipblock/baseurl/reqparams 属 api，access/billing/ratelimit 属 gate） | 链顺序常量放 L4′ `api/src/chain/order.ts` |
| `handlers/admin|apikey|auth|catalog|quota|rank|subjectrank|userconfig|verify/` | L4′ `api/src/routes/*/` | 面板契约 ① §6 |
| `app/` | L5 `apps/server/src/` + L4′ `api/src/app.ts` | `aggregate_search.go` → L4′（它要 gate + 各源）；`monitor.go` → L3（写明细）+ L4′（路由） |
| `sources/`（deploy 仓） | 源包 → `packages/source-<code>/`（源码形态）+ 发布产物 `plugins/<code>/<version>/` | 一源一包；族层（fq/qimao/acfun）成为同族共享包；**以插件形态落地，别先写成源码包再改** |
| `web/` | 原地 | 只改构建产物被 server 读取的方式 |
| `tools/`、`scripts/` | `tools/`（TS 版门禁脚本） | 见 §7 |

## 7. 门禁换血：Go 的 AST/文本扫描 → TS 的规则引擎

现仓 `make vet` 挂着 20 道脚本。迁移时**不能原样丢**，要按"为什么存在"重写：

| Go 门禁 | 它防的事 | TS 对应 |
|---|---|---|
| `param-assert-check` | query 值永远是字符串，数字断言是死代码 | `Params = Record<string,string>` 类型 + `no-unnecessary-condition` |
| `tz-check` | 时区/日界只有一处定义 | `kernel/clock` 单一出口 + `no-restricted-imports` 禁 `new Date()` 裸用 |
| `pagination-single-source-check` | 分页夹 6 处各写一遍 | `kernel/paging` 导出 `clampPage()` + 规则禁本地 `<1\|\|>100` |
| `ledger-write-check` | 审计写入不检查错误 | `store` 的写 API 一律 throw（不返回布尔）+ `no-floating-promises` |
| `settings-readers-check` | 设置键没人读（装饰位） | 生成的 `SettingKey` 联合类型 + `tsc` 的"未使用"报错 + 一条脚本比对声明表与 `getSetting` 调用点 |
| `config-wired-check` | 字段声明了但装配没写 | zod 严格模式（`strictObject`）解析 `process.env`：缺键即缺字段 |
| `lock-defer-check` / `goroutine-guard-check` | 锁/协程泄漏 | **随模型消失**（单线程 + `try/finally`），但换成 `onShutdown()` 注册表（防 ticker/interval 泄漏） |
| `deploy-atomic-check` | 部署写半截二进制 | 原样保留（部署脚本没变） |
| `doc-numbers-check` / `todo-status-check` / `docs-ref-check` | 文档与代码对不上 | 原样保留（都是文本脚本，与语言无关） |

`dependency-cruiser` 规则草案（照 §3 矩阵生成，落进 `tools/layer-rules.cjs`：

```js
// 只许向下：每层一个禁止"依赖除白名单外任何层"的规则
const LAYERS = {
  "packages/contract":        [],
  "packages/kernel":          ["packages/contract"],
  "packages/store":           ["packages/contract", "packages/kernel"],
  "packages/source-kit":      ["packages/contract", "packages/kernel"],
  "packages/gate":            ["packages/contract", "packages/kernel", "packages/store"],
  "packages/source-host":     ["packages/contract", "packages/kernel", "packages/store",
                               "packages/source-kit"],
  "packages/sources/":        ["packages/contract", "packages/kernel", "packages/source-kit"],
  "packages/api":             ["packages/contract", "packages/kernel", "packages/store",
                               "packages/source-kit", "packages/gate", "packages/source-host"],
  "apps/server":              ["packages/", "apps/server"],
}
// 另加三条：① packages/* 不许 import apps/*（下层认识上层）
//           ② packages/sources/* 之间只许 import 同族共享包（声明式例外表）
//           ③ packages/sources/* 不许 import store/gate/api/server（插件只认 SDK）
```

## 8. 迁移顺序（自下而上，每层一个可发布的里程碑）

| 步 | 做什么 | 完成定义 |
|---|---|---|
| 1 | L0 `contract`：把 ② 的字段全部写成 zod + 类型 | `tsc -b` + 契约快照用例通过；**前端类型可以从这里生成** |
| 2 | L1 `kernel`：config/log/clock/cache/fetch（undici + 熔断 + 代理 + singleflight）+ worker 池 | 假上游下的熔断/代理/超时用例全绿；`headersKey` 与 Go 版逐字节一致 |
| 3 | L2′ `source-kit`（SDK + manifest schema）+ L3 `source-host`（loader/蓝绿/回滚）+ 2 个最简源**以插件目录形态**落地（`wd_novel`、`huaben_novel`） | 这 2 个源能在**不起 DB、不起 HTTP** 的情况下用 fixture 跑出合法 DTO；host 能 reload 它们且不重启进程 |
| 4 | L2 `store`：建表/迁移/seed/settings/明细 | `:memory:` 全量迁移 + 幂等重跑通过 |
| 5 | L3 `gate` + L4′ `api` 的骨架（只挂 `datasources`/`data`/五动作） | 面板能登录、能看到源清单、能读一章——**首个可点开的面板** |
| 6 | 双跑对拍：Go 进程 vs TS 进程，逐源切流；另加一条**热更新对拍**（Go 重启一次 vs TS reload 一次，对外行为相同） | 每源 diff 为空才允许把该源从 Go 摘掉 |
| 7 | 剩余源按 ROI 滚（独立站 → 号池源 → 族层源 → `zj_novel`） | 每源的 DoD = 该源全部语料 diff 为空 + 面板对应页可用 |
| 8 | L5 `server` 收尾：socket activation、优雅停机、`pprof` 替代、SEA 打包、**插件目录纳入部署单元** | 现网升级脚本跑过一次 no-RST 验证 |

**不要先做第 8 步**：socket activation 与零停机是"最后 5%"，先做会拖住整条链。

## 9. 迁移时的新故障面（Go 版没有的）

| 风险 | 症状 | 对策（放在哪层） |
|---|---|---|
| 事件循环阻塞 | 某源一跑全站 P99 抖（同步 crypto / 大 JSON / cheerio 解析） | L1 `kernel/workers` 提供 worker 池；`source-kit` 的"重解析/重解密"入口默认走 worker |
| 内存无上限 | RSS 缓慢涨，容器 OOMKill | L1 缓存强制 `max` + `maxSize`；`store` 的分页一律有界；L5 加 `--max-old-space-size` + 观测 |
| native 模块 | `better-sqlite3` ABI 与应用镜像不一致 | 与 Go 的 cgo 同性质：构建镜像里预编译，部署只拷产物 |
| 定时器泄漏 | 维护协程/ticker 不停，重启后双跑 | L1 `onShutdown()` 注册表（替代 `ticker-stop-check`），SIGTERM 时统一 abort |
| 单文件产物 | "一个 strip 二进制"契约变松 | L5 用 Node SEA 或 bun compile；`web/dist` 与 `data/` 明确外置 |
| 插件换代不回收（进程内模型） | 每次 reload 留一代模块与包级缓存，世代计数缓慢增长 | L3 `source-host` 记 `generation` 并在超 N 时告警（“该维护窗口重启了”）；重源/第三方源走 worker 隔离（④ §2） |

## 10. 一句话验收

> **漏斗成立的自检**：把 `packages/contract` 与 `packages/kernel` 单独 `pnpm pack` 出去，
> 另开一个空项目 import 它们，能跑通（说明它们真的不认识业务）；
> 把 `packages/source-fq_novel` 单独 `pnpm pack` 出去，配一份假上游能跑出 DTO（说明源真的不依赖平台）；
> 把 `packages/source-host` 单独 `pnpm pack` 出去，喂一个 fixture 插件能 load/swap/rollback
> （说明宿主真的不依赖具体源）。
> 这三条过不了，分层就只是目录长得像。