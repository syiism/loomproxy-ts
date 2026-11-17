# 迁移 TS ①：接口契约（前端与下游不用改的那一面）

> 这一页是**冻结清单**：Go 版今天对外的 HTTP 面长什么样，TS 版必须逐字一样。
> 判据只有一条：**同一个请求打到两个进程，去掉时间戳/顺序/随机值后 JSON 相同**。
> 字段协议的正本在 [`迁移-TS-2-base字段协议.md`](迁移-TS-2-base字段协议.md)，分层正本在
> [`迁移-TS-3-漏斗分层与包边界.md`](迁移-TS-3-漏斗分层与包边界.md)。
> 现状事实来自 `app/app.go`、`middleware/*`、`handlers/*`、`base/legado/*`（2026-11-17 读码）。

## 1. 五条不许动的约定

1. **三个信封不许合并**：控制面 `{code,msg,data}`、数据面裸对象、`data_files` 原始字节（见 §2）。
2. **字段名一律 snake_case 或 camelCase 按现状**，不统一、不重命名。`search_tab`/`bookId`/`itemId`/
   `contentType`/`error_code` 这些名字同时被 Android 书源客户端与面板读，改名＝破坏下游。
3. **空值语义**：数据面 DTO 里大量字段用 `omitempty`（`Source`、`sources_status`、`nextTocUrl`）。
   TS 里 `undefined` 才等于"不发这个键"，`null` 会发出去——迁移时必须是 `undefined`。
4. **状态码语义**：400/401/403/404/429/503 各自的成因见 §7，不许把 403 改成 400。
5. **面板只认 `data`**：`web/src/api/client.js` 里 `code !== 0` 即抛错、成功取 `payload.data`。
   任何"顺手把 data 摊平"的改动都会让面板 47 个调用点一起坏。

## 2. 信封

### 2.1 控制面（`/auth/*`、`/admin/*`、`/quota/*`、`/user/*`、`/datasources`、`/endpoints`、`/announcement`）

```jsonc
// 成功（handlers/auth.Ok）
{ "code": 0, "msg": "ok", "data": { ... } }
// 失败（handlers/auth.Fail / 各中间件 AbortWithStatusJSON）
{ "code": <ERROR_CODE>, "msg": "中文人话" }
```

- `code` 取 `conf.ErrorCode`（`.env` 的 `ERROR_CODE`），**不是 HTTP 状态码的副本**；
  `/endpoints` 的 401 与 `NoRoute` 的 404 是例外（手写 `500`/`404`）。TS 版照抄这两个例外。
- `/endpoints` 多一个 `count` 键（`{code,msg,count,data}`）。

### 2.2 数据面（`/{source}/{action}`）

**裸对象，不加 `code/msg`**。成功＝`200` + 该动作的 DTO（见 ② 文档）。失败两条路：

- 传输层/上游错误 → `handleError`：`4xx/5xx` + `{code,msg}`，`msg` 已脱敏（签名参数不外泄）。
- 带内错误 → **`200`** + `{"contentType":"error","data":{"message":"…"}}`（Legado 书源传统写法）。

`ContentResponse.Data` 里允许出现源自己加的键（`reason`/`code`/`bookId`/`title`…），骨架只搬运：
`reason` 进 `CallSubject.InBandReason`、`code` 进 `InBandCode`，**不解释、不改写**。

### 2.3 `data_files`（`/data`、`/data/:source`、`/data/:source/:name`）

- 命中文件：**直接写文件字节**，`Content-Type: application/json; charset=utf-8`（不过 JSON 封装）。
- 没命中/路径非法：`404` + `{"error":"…"}`（`catalog.NotFoundResponse`），**不列可用文件清单**（枚举面收敛）。

## 3. 鉴权（四形态 + 一个例外）

凭证解析顺序（`utils.TokenFromRequest` + `utils.resolveAPIKey`）：

| 顺位 | 形态 | 位置 |
|---|---|---|
| 1 | JWT | `Authorization: Bearer <token>` |
| 2 | JWT | `?token=` query（给不支持头的客户端） |
| 3 | JWT | Cookie（`TokenCookieName`） |
| 4 | API Key | `X-API-Key: <key>` 或 `?api_key=` |

语义三分（迁移时别混）：

- `AUTH_ENABLED=false`：**不强制**但仍尽力解析身份（P64），解析失败按匿名放行。
- `VerifyAuth`（数据面 `AuthRequired`）：白名单命中 → 免强制；声明了 `IdentityOptional` 的端点
  （`/datasources`、`/endpoints`）在白名单里**仍然解析**，否则按套餐裁剪的那段是死代码。
- `AuthenticateAny`（用户域）：控制面一律要凭证，且**静态 env 键不算身份**（403 + 明确文案）。

失败文案固定为「缺少鉴权凭证（Authorization Bearer / Cookie / X-API-Key / api_key）」，
**带了错票要报票的错**（密钥被撤销/归属用户禁用），不许统一成"缺凭证"。

## 4. 中间件链（顺序本身就是契约）

顺序由 `middleware.Def.Order` 声明、`sort.SliceStable` 装配，不靠 import 顺序。

| Order | 名字 | 挂载条件 | 作用 |
|---|---|---|---|
| 10 | requestid | 全局 | 生成/透传 `request_id`，响应头同名 |
| 20 | recovery | 全局 | panic → 500 |
| 30 | logging | 全局 | 访问日志 |
| 40 | cors | 全局 | 预检（必须早于 IPBlock） |
| 50 | cachecontrol | 全局 | 面板静态资源缓存头 |
| 60 | ipblock | 全局 | IP 黑名单 + 自动拉黑计数 |
| 100 | apiauth | `AuthRequired` 路由 | 四形态鉴权 |
| 200 | monitor | 数据面路由 | 调用明细/计数（**早于** 400/500/600，否则 403/429 不见） |
| 300 | baseurl | 数据面路由 | `baseUrl` 解析（用户配置 → 平台配置 → 源默认）+ SSRF 校验 |
| 350 | reqparams | 数据面路由 | 按 `SourceMeta.RequiredParams` 校验，缺 → 400 |
| 400 | access | 数据面路由 | 源启用 + 套餐授权（= 有没有那行限额） |
| 500 | billing | 数据面路由 | 成本配置/额度预检；上游成功后扣减（同内容 300s 去重） |
| 600 | ratelimit | 数据面路由 | IP 与用户双维度限流，两者都放行才放行 |

三条隐性不变量（现网靠注释维持，TS 版要写成用例）：
Monitor 早于 Access/Billing/RateLimit；IPBlock 晚于 CORS；RequiredParams 晚于 BaseURL 但早于 Access。

## 5. 数据面：`/{source}/{action}`

### 5.1 参数注入规则（`app.buildParams`，逐条照抄）

1. 只注入 handler 自己声明的 `QueryParams`，其余 query 一律忽略（不是"全量透传"）。
2. 值**永远是字符串**，不做数字转换（`param-assert-check` 就是钉这条）。
3. 空串不注入（键都不出现）；`GetParam` 取不到返回 `""`。
4. `baseUrl`：query 里没有就从 `middleware.CtxResolvedBaseURL` 取（用户配置→平台配置→源默认）。
   源声明 `FixedBaseURL` 时路由**不接收** `baseUrl`，也不做 SSRF 校验。
5. `__uid`：平台注入的当前用户 ID（数字），源可以读来做按用户隔离。
6. `_` 前缀是平台保留字（`_datafile_parts` 等），源不许声明。
7. `data_files` 特例：从路径段取 `source`/`name`，塞进 `_datafile_parts`。

### 5.2 五个动作（下游书源默认动作集）

> **实现形态变了、契约没变**：为支持热更新，路由从启动期逐条注册改成「静态路由优先 + `/:source/:action`
> catch-all 派发」（见 [`迁移-TS-4-源插件与热更新.md`](迁移-TS-4-源插件与热更新.md) §5）。
> 对外 URL、参数注入规则、响应形状**一个字都不变**；变化的是 `SourceMeta` 在**派发时现取**，
> 而不是启动期固化。

| 动作 | 典型 query | 响应 |
|---|---|---|
| `search` | `key`（别名 `keyword`/`query`/`wd` 只在观测层认）；部分源自用 `query`+`page` | `{bookList:[BookItem]}` |
| `detail` | `bookId` | `BookDetail` |
| `chapter` | `bookId` | `{chapterList:[ChapterItem],nextTocUrl?}` |
| `content` | `bookId`+`itemId`（少数源只要 `itemId`） | `{contentType,data}` |
| `explore` | `url` 或 `category`+`page` | `{bookList:[BookItem]}` |

动作集由源在 `SourceMeta.Actions` 声明，路由对账只告警不阻断。**平台不做书源特例分支**。

### 5.3 聚合搜索

`/{source}/search?sources=a,b` → `app/aggregate_search.go` 扇出：

- 路由源永远第一个（这条请求本来就是从它进来的）；`sources` 里其余源逐个过
  `gate.SourceAccessVerdict` + 额度 + 各自 `baseUrl` 解析（**这条路径不经过中间件链**，所以判定复用同一函数）。
- 每源并发上限 `AggregatePerSourceMax`（默认 4，跨请求共享）。
- 结果合并后**每源自己打标**，出口**不再**用路由源覆盖（`StampSearchSource` 只对非聚合那次跑）。
- 部分源失败不影响整体：`sources_status` 里报每源 `ok/failed:原因`。

### 5.4 出口三处改写（顺序固定）

1. `legado.ObserveCall(source, params, result, subject)` → 回填内容维度（名称/媒介/条数/带内错误）。
2. `legado.StampSearchSource(result, source)` → 每条 `bookList[i].source` 与 `kind` 首项写源码。
3. `scrubInBandMsg(result)` → 只改带内错误的 `message` 文案（脱敏），不动正文/状态码/计费。

维护模式（设置 `maintenance_mode`）在 handler 之前拦：数据面 `503 {code,msg:"系统维护中，请稍后再试"}`，
管理员放行。

## 6. 控制面端点清单

> 面板调用点全部在 `web/src/api/index.js`（186 行、47 个方法）。**这张表就是"前端不改"的全部范围。**

### 6.1 公开/半公开

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | `{app:"LoomProxy",status:"ok",panel:"/panel"}`（**裸对象，不是信封**） |
| GET | `/panel`, `/panel/*` | Vue SPA（go:embed → TS 版改为读 `web/dist`，见 ③ §6） |
| GET | `/favicon.svg` | 静态 |
| GET | `/datasources` | 按套餐裁剪的源清单（`IdentityOptional`，缓存键含 uid） |
| GET | `/data`, `/data/:source`, `/data/:source/:name` | 静态字典 |
| GET | `/endpoints` | 按套餐裁剪的端点清单（必须登录归属，401 文案见 §3） |
| GET | `/announcement` | `{content, maintenance}` |

### 6.2 用户域

| 方法 | 路径 | 前端方法 |
|---|---|---|
| POST | `/auth/register` `/auth/login` `/auth/logout` `/auth/forgot-password` `/auth/password` `/auth/privacy` `/auth/quota-cycle` `/auth/sessions/revoke-others` | — |
| GET / PATCH | `/auth/me` | `me` / `updateMe` |
| PUT | `/auth/display-alias` | `updateDisplayAlias` |
| GET / DELETE | `/auth/sessions`、`/auth/sessions/:id` | `listSessions` / `revokeSession` |
| GET/POST/DELETE | `/apikey`、`/apikey/:id` | `apikeyApi.{list,create,revoke}` |
| GET | `/quota/dashboard` `/quota/usage-logs` `/quota/transfers` | `quotaApi.{dashboard,myUsageLogs,myTransfers}` |
| POST / DELETE | `/quota/transfer`、`/quota/transfers` | `transfer` / `clearTransfers`（**只认会话**） |
| GET / PUT | `/user/source-configs` | `userConfigApi.*` |
| GET | `/user/import-config` | `getImportConfig` |
| POST | `/user/redeem` | `redeem` |
| GET / POST | `/verify/config`、`/verify/send` | `verifyConfig` / `sendVerifyCode` |
| GET | `/rank/boards` | `rankBoards`（放行范围按设置 `rank_public_sources`） |

### 6.3 管理域（`/admin`，`AdminRequired()`）

| 域 | 端点 |
|---|---|
| 统计/用户 | `GET /stats`；`GET/POST /users`、`GET/PATCH/DELETE /users/:id`、`POST /users/:id/{restore,roles,reset-password,refresh-quota,quota-transfer}`、`PUT /users/:id/{plan,quota}`、`GET /users/:id/{quota,quota-transfers}` |
| 设备/安全 | `GET /devices`；`GET /security/attempts`、`POST /security/attempts/reset`；`GET/POST /blocked-ips`、`DELETE /blocked-ips/:id` |
| 角色 | `GET/POST /roles`、`PATCH/DELETE /roles/:id` |
| 设置 | `GET/POST /settings`、`PUT/DELETE /settings/:key` |
| 套餐与限额 | `GET/POST /quotas/plans`、`PATCH/DELETE /quotas/plans/:id`、`GET /quotas/plans/:id/{limits,data-sources}`、`POST /quotas/plans/:id/{data-sources,data-sources/batch,sources,clone-sources}`、`DELETE /quotas/plans/:id/data-sources/:ds_id`、`POST /quotas/limits`、`PUT/DELETE /quotas/limits/:id` |
| 接口成本 | `GET /quota-costs`、`PUT /quota-costs/:id`、`GET /quota-costs/plans`、`PUT /quota-costs/plans/:id`、`POST /quota-costs/plans/upsert` |
| 用量流水 | `GET /usage-logs` |
| 监控 | `GET /monitor`、`GET /monitor/history`、`GET /monitor/trend`、`GET /monitor/subjects`、`GET /monitor/report.html`、`POST /monitor/reset`、`POST /monitor/backfill-subjects` |
| 号池 | `GET /pools`（`pool.StatusAll()`，凭证只列键名） |
| 卡密 | `GET/POST /redeem-codes`、`POST /redeem-codes/:id/revoke`、`POST /redeem-codes/revoke-selected`、`DELETE /redeem-codes/batch/:batch_no` |
| 源配置/分组/定时 | `GET/PUT /source-configs`；`GET/POST /source-groups`、`PATCH/DELETE /source-groups/:id`、`PUT /source-groups/:id/members`、`POST /source-groups/:id/apply-limits`；`GET/POST /source-schedules`、`PATCH/DELETE /source-schedules/:id` |
| 数据源 | `GET/POST /data-sources`、`PATCH/DELETE /data-sources/:id` |
| 源插件（热更新） | `GET /admin/sources/plugins`；`POST /admin/sources/:code/{reload,rollback,disable,unload}`；`POST /admin/sources/reload-all` —— **新增**，见 [`迁移-TS-4-源插件与热更新.md`](迁移-TS-4-源插件与热更新.md) §7 |

`/monitor/report.html` 是**服务端渲染 HTML**（不是 JSON），TS 版要么照抄模板，要么退化成 302 到面板页——
**这条要单独拍**（面板里有入口链到它）。

## 7. 状态码字典

| 码 | 成因 | 文案来源 |
|---|---|---|
| 400 | 缺必填参数（`reqparams`）、baseUrl 非法/SSRF | 中间件 |
| 401 | 缺凭证/凭证无效/会话过期 | apiauth、`/endpoints` 自守 |
| 403 | 有身份但无权限（未授权源、接口被禁用、静态键用作身份） | access、billing |
| 404 | 源不存在（`not_found`）、无路由、静态字典缺 | access、NoRoute、datafiles |
| 429 | 今日额度用完 / 限流（按 IP 或用户） | billing、ratelimit |
| 500/502/504 | 上游读失败 / 上游非 2xx / 上游超时 | `handleError` |
| 503 | 维护模式 / 熔断全开 | app、fetch 栈 |

`handleError` 的映射必须照抄：`context.Canceled` 直接静默返回（不写响应体），
`UpstreamError.StatusCode==0` 且 `DeadlineExceeded` → 504「上游请求超时」，其余 `0` → 502。

## 8. 迁移期怎么证明"没漂"（对拍方法）

1. **黄金语料**：每个源取 5–10 条真实请求（search/detail/chapter/content/explore + 4 类边界：
   缺参、免费、付费、风控），存 `{path, query, headers, status, body}` 快照（去掉易变字段：
   `timestamp`/`nonce`/`sig`/`expire`/`latency`/排序）。
2. **双跑**：同一条语料分别打 Go 进程与 TS 进程，diff 结果必须为空。
3. **面板回归**：47 个前端方法逐个跑一遍（面板页面点全部路由，`viewport-check` 那套脚本可复用）。
4. 上述三条进 CI 后，**任何字段改动会先红**——这就是替代"人工记得别改名"的唯一办法。

热更新相关的变化**不在这一页的范围**：URL 与 JSON 形状不变，只新增了 `/admin/sources/*` 一组管理端点
（见 ④ §7）；`/datasources`、`/endpoints` 的缓存键要多带一段 `registry_generation`，那是实现细节。