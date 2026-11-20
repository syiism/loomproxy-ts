# AGENTS.md — loomproxy-ts 分支的执行纪律

> 本分支是 Go 版 LoomProxy 的 TS 重写（孤儿分支，无 Go 代码）。
> 交接先读 `WORKLOG.md`（状态/命令/不变量/踩坑台账/下一步）；设计与字段正本在 `docs/方案/迁移-TS-{1..4}.md`；**代码与那四页冲突时改代码并回写那四页**。

## 1. 硬约束（违反即回滚，不讨论）

1. **不许出现 Go 代码**：`tools/check-layers.mjs` 会扫全树，`.go` 文件当场红。
2. **依赖只许向下**：`contract → kernel → store/source-kit → gate/source-host → api → apps/server`。
   新增包先在 `tools/check-layers.mjs` 的 `LAYER`/`ALLOW` 里登记，再写代码。
   `source-kit` **不许 import store**（设置走注入的 `SettingsReader`）；`api` **不许 import 具体源包**。
3. **契约不许漂**：数据面是裸对象（不加 `code/msg`）、控制面 `{code,msg,data}`、
   `omitempty` → `undefined`（不是 `null`）、字段名逐字照抄。改任何一条都算破坏前端（① §1）。
4. **Node strip-only 语法**：不用 `enum` / `namespace` / 构造器参数属性 / 装饰器。
   类型导入一律 `import type`（`verbatimModuleSyntax`）。
5. **源码即插件**：14 个源包直接住在 `plugins/<code>/<version>/`（无打包步骤、无 `packages/sources/`），
   一码一 `deps/`（SDK 源码 + 第三方 JS 依赖，多版本共享）。新源照这个结构（`manifest.json` 是唯一声明位、
   映射逻辑进 `src/normalize.ts` 且可单测、宿主用 `packages/source-host/test/fixtures/*` 夹具验证）。
   **不许在 plugins/ 下建软链**（拷走就断）；SDK 必须走相对 deps 路径，第三方纯 JS 包以真实文件放
   `<code>/node_modules/`；依赖变更跑 `pnpm run sync:plugins`。
   **完整编写范式见 `docs/方案/源插件编写范式.md`**（目录结构/manifest 字段表/三种转写形态/测试与上线清单）。
   **协议层复用外部参考实现**（`/home/muyang/work/novels/fanq`，见 README「外部依赖」）时，
   不要顺手把签名/加密/会话池抄进本仓——那是最容易与上游漂移的一块。

## 2. 改完必须跑

```bash
pnpm run check     # 分层 + tsc + 面板构建 + 全部用例
```

三条都要绿。用例**不许**连真实上游、不许依赖 MySQL/Redis：`gate/api/source-host` 用内存实现，
`source-host` 用夹具插件，`api` 用 `inject()`。

## 3. 每层自己的判据（对应 ③ §5）

| 层 | 判据 |
|---|---|
| `contract` | zod 正/反例 + 黄金 JSON 快照（空值语义、字段名、媒介映射） |
| `kernel` | 假上游/假时钟下的缓存、合并、熔断、超时、配置默认值 |
| `store` | 幂等登记（不覆盖管理员改过的值）、敏感键只写不回显 |
| `source-kit` | 注册表换代原子性 + "在飞请求拿的是它进门前那一代" |
| `gate` | 六档访问判定顺序、双维限流、去重窗口 |
| `source-host` | 扫描/reload/rollback/drain/卸载 + 四种坏插件各留记录且不拖垮别人 |
| `api` | 信封形状、参数注入规则、必填参数 400、未知源 404、插件管理要管理员 |
| `plugins/<code>/<version>` | 映射纯函数用例（不连网）+ `node tools/plugin-run.mjs <code> <action>` 实网跑通一个动作 |
| `apps/server` | `compose()` 起得来：无插件目录也能起，有插件立即可派发 |

## 4. 插件（源包）的三步跑通

```bash
node tools/plugin-run.mjs fq_novel search query=三体     # ① 单插件直跑（真上游）
node tools/sync-plugin-deps.mjs fq_novel                 # ② 修依赖/重建 deps 与 node_modules（无打包产物）
PLUGIN_DIR=plugins node apps/server/src/main.ts          # ③ 起服务 → curl /datasources、/fq_novel/search
```

三条都过才算"跑通"。映射逻辑必须放进 `src/normalize.ts` 并能被 `node --test` 单独覆盖——
不要在 handler 里直接拼 DTO（那是下一步换源时要改的唯一地方，得可测）。

## 5. 面板（web/）的规矩

- **这份面板是原 Go 项目的 `web/` 原样搬入的**（不是重写）。改动只允许两种：
  ① 补后端已实现端点的 api 方法；② 新增页面（要同时在 `api/index.js`、`main.js` 路由、
  `App.vue` 的 `adminNavGroups` 三处登记——漏一处就是"页面在了但点不到"）。
- 后端没有的域（额度/套餐限额/卡密/分组/定时/IP/设备/接口消耗）**页面保留、端点回 501**：
  报错原样 toast，比空壳假数据诚实。**不要**为了让页面"绿"而回成功空响应。
- `web/src/api/client.js` 与 Go 版同一份契约：成功取 `payload.data`、`code !== 0` 抛错、401 清票跳登录。
  这三条任意一条改动，面板里所有调用点一起坏。
- 路径挂在 `/panel`（`vite base: '/panel/'` + router `createWebHistory('/panel')`），产物由
  `packages/api/src/web.ts` 托管（`/panel/*` 回退 index.html，`assets/` 长缓存，其余 no-cache）。
- 改完必须 `pnpm run check:web`；`pnpm run check` 已经包含它。

## 5.1 面板与原仓的差异（目前只有两处）

- 面板**挂在根路径**（`/` + `/assets/*`），不再是 `/panel`（退役：301 到干净路径）。
  两段路径的归属冲突用"是不是已登记源 + Accept 是否 text/html"区分，**不要**退回 hash 路由。
- 健康检查在 `/health`；`/` 是面板，不再回 JSON（探针/监控改指 `/health`）。

- `web/src/pages/admin/Settings.vue` 删掉了末尾那行裸 `load()`：`onMounted` 已经调过，
  原样保留会让 `/admin/settings` 一次进页面打两发（其余页面的裸 `load()` 是唯一的加载点，不要动）。
- 新增页/入口三件套（`api/index.js` 方法、`main.js` 路由、`App.vue` 的 `adminNavGroups` + `iconMap`/`SidebarIcon`）。

## 6. 数据库（packages/store）

- **只有这一层碰持久化**：其他层拿 `UserStore/SettingsStore/DataSourceStore/CallLogStore…` 接口。
- 当前实现：`node:sqlite`（Node 内置）+ 手写 DDL（`sqlite.ts` 的 `SCHEMA`）。加表 = 在 SCHEMA 里
  `CREATE TABLE IF NOT EXISTS` + 一个 Repo；**不要**在业务层拼 SQL。
- `DB_PATH` 默认 `DATA_DIR/loomproxy.db`；用例用 `:memory:`。
- 口令用 scrypt（`hashPassword/verifyPassword`）；**旧库迁移进来的 bcrypt（`$2a$/$2b$/$2y$`）由 `verifyPassword` 兼容校验，但新口令一律 scrypt**（`tools/mysql-to-sqlite.mjs` 从 Go 备份迁入 1,678 个 bcrypt 用户，不兼容就没人能登录）。会话是**现行校验**（JWT 带 jti，撤销即刻失效）。
- 播种（角色/默认套餐/管理员/内置设置）在 `apps/server/src/compose.ts`，**幂等**：已存在的不覆盖。
- 未接域一律 501 + 人话（`notWired()`），不要返回成功空响应。
- JWT claims 必须与 Go `utils/jwt.go` 同形（`uid`/`username` + jti/iat/iss/sub，`exp` 可缺省）；
  **角色永远从库里读**，不要往 token 里塞 roles。外来 jti（本库没有）按签名放行，本库有的必须有效。
- 设置项**声明了就要有读取方**：`BUILTIN_SETTINGS`（store/seed.ts）里每条内置设置在代码里都要有人读
  （公告→/announcement；注册开关/默认角色/默认套餐/邮箱名单→/auth/register；维护模式→dispatch；
  验证码场景→/verify/config；jwt_expire_hours→登录签发）。新增键时同一批补读取方与用例，
  否则它只是面板上的装饰位（Go 版 P53 那条判据）。
- 管理员口令：`ADMIN_PASSWORD` 只用于**创建**；改密/重置后必须写 `kv_state` 的
  `admin_password_source:<名字>=panel`，否则下次重启会被 env 覆盖（或反过来让 env 永远不生效）。
- `DATA_DIR`/`DB_PATH` 相对 cwd：启动日志必须打印解析后的库路径与管理员名，否则"换目录启动"会表现成"密码错"。
- 额度域三条不变量：①**限额即授权**（`quota_limits` 里 `scope='source'` 的一行同时决定"能不能用"与"用多少"）；
  ②生效顺序 `用户覆盖 → 套餐 → -1(不限)`，每次请求现取（改完立刻生效，不许烘进启动期）；
  ③只有**成功且非带内失败**才记账，同内容在 `BILLING_DEDUPE_SEC` 内只扣一次。
- `limit` 是 SQLite 保留字：列名与别名都要加引号（别名别再用 `limit`，踩过一次语法错误）。

## 7. 写代码的约定

- **凡是"一处事实"的东西只留一处**：分页夹（`kernel/paging`）、时区日界（`kernel/clock`）、
  设置类型（`contract` 的 `SETTING_TYPES`）、缓存键含"这条响应属于谁"。
- 缓存键必须含身份维度；插件换代必须 bump `registry.generation`（并进 `/datasources` 缓存键）。
- 上游请求只走 `ctx.fetch`（源）或 `Upstream`（平台）：不许自建 `undici` 实例，
  否则绕开熔断/代理/共享缓存/合并。
- 错误文案外发前必须脱敏：`?query` 整段替换（`scrubQuery`）、带内 `message` 走 `sanitizeUpstreamMsg`。
- 定时器/监听器一律登记到 `ShutdownRegistry`（SIGTERM 时统一收）。
- 注释写"为什么"，不写"做了什么"；踩过一次的坑写成用例或 `check-layers` 规则，不要只写进注释。
- **代码与文档同步更新**：改动行为、模块职责或实现位置时，同一批提交必须回写对应文档
  （文件头注释、`README.md`、`WORKLOG.md`、`docs/方案/迁移-TS-{1..4}.md`）——
  设计正本与代码冲突时以代码事实为准修正双方（见开头总则），不允许只改一边留下漂移。
- **关键变更必须记进 `WORKLOG.md`**：凡是改变行为、契约/字段、分层或依赖、不变量（WORKLOG §4）、
  新增端点/表/源包、修掉一个踩过的坑，同一批提交里必须更新 WORKLOG——不是记流水账，
  只记影响后来人判断的东西：头部「一句话状态/最近一次提交」、§3 能力、§4 不变量、
  §6 踩坑台账（症状 → 真因 → 判据）、§10 提交索引，按需落位。
  纯格式、改名、补注释之类不改语义的小修可以跳过；漏记等于把坑留给下一个会话。
