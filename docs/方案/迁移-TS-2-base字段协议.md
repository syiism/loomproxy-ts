# 迁移 TS ②：base 包的字段协议

> 这一页是**数据形状的唯一真源**：声明位、DTO、取数签名、号池状态、观测字段、配置键。
> Go 版实现在 `base/`（含 `base/legado/`、`base/pool/`）、`models/`、`conf/`；TS 版的
> `packages/contract` 就按这页逐字段生成 zod schema，**任何字段增删先改这页**。
> 接口表现层见 [`迁移-TS-1-接口契约.md`](迁移-TS-1-接口契约.md)，分层见
> [`迁移-TS-3-漏斗分层与包边界.md`](迁移-TS-3-漏斗分层与包边界.md)。

## 1. 四组协议，四种命运

| 组 | 名字 | 谁依赖它 | 迁移策略 |
|---|---|---|---|
| 声明位 | `SourceMeta` 及其子结构 | 源（声明方）↔ 平台（消费方） | **逐字段照抄**，value 校验挪进 zod |
| 五动作 DTO | `base/legado` 的 6 个结构 | 平台 ↔ 下游客户端 | **逐字段照抄**，`omitempty` → `undefined` |
| 取数/池 | `BaseHandler`、`pool.Provider` | 源 → 平台 | 签名照抄，`ctx` 换成 `AbortSignal` |
| 状态/观测 | `CallSubject`、`pool.Status`、`models` | 平台内部 + 面板 | 字段照抄（它们是面板契约） |

## 2. 声明位 `SourceMeta`（`base/registry.go`）

```jsonc
{
  "code": "fq_novel",            // 数据源码：data_sources.name / 路由前缀 / quota 的 group_code
  "display": "番茄（小说）",       // 显示名
  "category": "fq",              // 分类
  "description": "…",            // 可选
  "sort_order": 10,              // /datasources 顺序
  "status": 1,                   // 1 启用 / 0 禁用（播种用）
  "actions": ["search","detail","chapter","content","explore"],
  "required_params": { "detail": ["bookId"], "content": ["bookId","itemId"] },
  "fixed_base_url": false,       // true = 地址写死在源里，路由不收 baseUrl、不做 SSRF
  "search_tabs": [ { "tab_type": 3, "bd_id": "2", "name": "小说", "media_type": "novel" } ],
  "legacy_groups": ["…"],        // 历史组码，seed 时展开为 code（组概念已移除）
  "data_files": [ { "name": "fq_cats", "description": "分类字典" } ],
  "media_type": "novel",         // 默认媒介；多媒介源**不要**填
  "settings": [ { "key": "zj_key_mode", "type": "string", "default": "", "description": "…", "sensitive": true } ]
  // on_boot: 函数，不进 JSON
}
```

逐条要点（都是踩过的坑，别"顺手简化"）：

| 字段 | 校验/副作用 | 不许做的事 |
|---|---|---|
| `code` | 必填、进程内唯一，冲突 `log.Fatalf` | 复用已下线源的名字（会串历史额度/配置） |
| `actions` | 必填、非空；与路由对账（缺路由只告警） | 声明了却实现不了（对账只告警，会静默少动作） |
| `required_params` | 路由层校验，缺 → **400** | 让源返回带内 error 正文（HTTP 200 会被当正文渲染） |
| `fixed_base_url` | 影响是否收 `baseUrl`、是否做 SSRF | 声明了又去读 `params["baseUrl"]` |
| `search_tabs` | 下发 `/datasources`；`media_type` 走 `base.IsValidMedia` | 用分类名做分支（平台不做源特例） |
| `media_type` | 空 = 未声明；非法值注册期 Fatal | 多媒介源填默认值（把误判固化） |
| `settings` | `db.Init` 期落 `system_settings` 行（存在则只对账 type）；`sensitive` 进只写不回显 | 在 `OnBoot` 里自己造 setting 行、改骨架 seed |
| `data_files` | 启动期核对文件在位，缺 → ERROR 日志（不阻断） | 把部署产物当构建输入 |

`OnBoot` 契约（`RunSourceBoots`，在 `db.Init` 之后、`pool.StartAll` 之前按 `SortOrder` 调）：

- **必须幂等**（测试环境会重复装配）；返回 error 只记日志、不阻断启动；panic 被 recover 后继续。
- 需要读 `.env` 的源开关、登记号池、做初始导入 → 放这里；包 `init()` 里 `process.env` 读不到 `.env`。

### 2.2 插件化之后：声明位从"编译期注册"变成"manifest + 运行期落地"

为支持不重启加源/更新源（见 [`迁移-TS-4-源插件与热更新.md`](迁移-TS-4-源插件与热更新.md)），
`SourceMeta` 的**形状不变**，但载体和时机变了：

| | Go 今天 | TS 插件化 |
|---|---|---|
| 载体 | `init()` 里 `RegisterSource(SourceMeta{...})` | 插件目录的 `manifest.json`（就是本页 §2 的 JSON 形态） |
| 时机 | 包导入期（进程启动） | `import()` 那一瞬（可在运行期任何时刻） |
| 校验 | 注册期 `log.Fatalf` | zod 校验 + 拒绝加载（**保留老代**，不是整进程死） |
| 行落地 | `db.Init` 一次性 | 每次加载幂等 upsert（不覆盖管理员改过的值） |
| `OnBoot` | 启动期一次 | 每次加载都调（所以幂等从"建议"变成"硬要求"） |
| 三格新增元信息 | — | `sdk_version`、`isolation`、`entry`（不在 `SourceMeta` 内，属插件元信息） |

`SourceMeta` 字段不变、`omitempty`/`*int` 等语义不变——这是“前端与下游不改”的前提。

### 2.1 子结构

```ts
SearchTab   = { tab_type: number, bd_id: string, name: string, media_type?: Media }
SettingDecl = { key: string, type: "string"|"bool"|"number"|"json"|"json_object",
                default: string, description: string, sensitive?: boolean }
DataFileDesc= { name: string, description: string }
Media       = "novel" | "audio" | "comic" | "video"   // 空串=未判定，是合法状态
```

设置类型只有五档，**是行为声明不是标签**：面板写入端与声明位校验必须读同一个函数
（Go 的 `base.ValidSettingType`；TS 版用一个 zod enum + `isValidSettingType` 单一出口）。

## 3. Handler 接口与 `BaseHandler`

```go
type Handler interface {
  Handle(ctx, params map[string]interface{}) (any, error)
  GetPath() string; GetMethods() []string; GetName() string
  GetDescription() string; GetQueryParams() []string
  AuthRequired() bool; PrefersIdentity() bool
}
```

`BaseHandler` 字段（源拿它当 HTTP 执行器 + 元数据）：

| 字段 | 含义 | 迁移注意 |
|---|---|---|
| `Path` / `Name` / `Methods` / `QueryParams` | 路由与参数白名单 | `QueryParams` 决定**注入哪些 query**，不是文档 |
| `Description` | 进 `/endpoints` | 面板可见文案 |
| `Auth` | → `AuthRequired()` | 数据面默认 `true` |
| `IdentityOptional` | 白名单里仍解析凭证 | `/datasources`、`/endpoints` 必须置 |
| `UpstreamCacheTTL` | >0 时 `FetchJSON/FetchText` 走上游短 TTL 缓存 | detail/chapter 设秒级；content 保持 0 |
| `Config *APIConfig` | 用户级 baseUrl 等 | 见 ③ 的注入方向 |

`params` 的取值口径：键存在 = 非空字符串（§5.1 已写）；`GetParam/ParamString` 缺键返回 `""`。

## 4. 五动作 DTO（`base/legado/`）

字段顺序即序列化顺序（Go 结构体顺序），TS 建对象时的键序也要一致（对拍时省 diff 噪声）。

### 4.1 搜索 `search_base.go`

```jsonc
// SearchResponse
{
  "bookList": [{
    "bookId": "…", "name": "…", "author": "…", "kind": "…",   // kind 首项 = 数据源码
    "wordCount": "…", "lastChapter": "…", "intro": "…", "coverUrl": "…",
    "bookType": "…",            // 可选
    "bookTypeCode": 1,          // 可选，指针语义：0 与"缺失"不同，别用 0 兜底
    "source": "fq_novel"        // 可选，出口统一打
  }],
  "sources_status": { "fq_novel": "ok", "qm_novel": "failed:timeout" }  // 仅聚合时
}
```

`bookTypeCode` ↔ 媒介（`base.MediaFromBookTypeCode`）：`0/4 → novel`、`1 → comic`、`2 → audio`、
`3 → video`，其余空。搜索项里它是 `*int`，**缺失 ≠ 0**（0 也是 novel），TS 用 `undefined`。

### 4.2 详情 `detail_base.go`（`BookDetail`，全部非指针、全部必发）

`bookType, bookTypeCode, authorId, bookId, name, aliasName, author, status, createTime,
lastUpdateTime, wordCount, category, tags, roles, tones, score, readCount, source, intro,
copyright, bookReview, coverUrl, lastChapter`

### 4.3 目录 `chapter_base.go`

```jsonc
{ "chapterList": [{ "title": "…", "itemId": "…", "chapterInfo": "…", "isVip": false }],
  "nextTocUrl": "…" }   // 可选；存在 = 还有下一页（下游会跟）
```

### 4.4 正文 `content_base.go`

```jsonc
{ "contentType": "novel|audio|comic|video|manga|text|image|error", "data": { … } }
```

`contentType` 的合法来源三处（`base.MediaFromContentType`）：Legado 规范词 `text/image/audio/video`、
本仓既有写法 `novel/manga/comic`、以及 `error`（→ 空媒介）。**`data` 是开放字典**：
最少 `{"content": "…"}`；音频/视频为直链；错误为 `{"message": "…"}`，可附 `reason`/`code`。

### 4.5 发现 `explore_base.go`（`{bookList:[BookItem]}`）——形状与搜索同，**不带** `sources_status`

## 5. 错误协议

```go
type UpstreamError struct { StatusCode int; Message string; Cause error }
```

| 场景 | 类型 | 出口 |
|---|---|---|
| 上游非 2xx | `*UpstreamError`（StatusCode=上游码） | `handleError` 映射 502/504（见 ① §7） |
| 上游业务码（源自定，如 xmly `ApiError`） | 源包自己定义 | 源决定：带内 error 或 `UpstreamError` |
| 超时/连接 | `net.Error` / `context.DeadlineExceeded` | 504「上游请求超时」 |
| 客户端取消 | `context.Canceled` | **不写响应体**，只记日志跳过 |

**带内错误的三个可选键**（骨架只搬运、不解释）：`data.message`（必填人话）、
`data.reason`（枚举：`upstream_network/upstream_status/pool_unavailable/parse_empty/unauthorized`）、
`data.code`（站方信封业务码）。三者分别落到 `CallSubject.InBandError/InBandReason/InBandCode`。

脱敏口径：`err.Error()` 可能含完整签名 URL（app_key/sig/device_sn），
**只有带内 `message` 会被 `scrubInBandMsg` 洗**；`handleError` 那条路自己 `scrubQueryForLog`。
TS 版把这两个函数原样搬过去，别用 logger 拼 URL。

## 6. 取数栈（源唯一允许的 HTTP 出口）

```go
Fetch(ctx, url, method, headers, body) (*http.Response, error)
FetchJSON(ctx, url, headers) (map[string]any, error)
FetchText(ctx, url, headers) (string, error)
FetchShared(ctx, url, method, headers, body, cacheKey string, ttl time.Duration,
            cacheIf ResponseFilter) (body []byte, status int, err error)
type ResponseFilter func(body []byte) bool   // 决定"这次响应能不能进缓存"
```

不许自建 http 客户端（否则绕开熔断/代理/共享连接池/UA 轮换）。

代理与请求头的落地（2026-11-18 实测过）：

- 池 = `UPSTREAM_PROXIES`（逗号分隔）+ `UPSTREAM_PROXY_FILE`（每行一个、`#` 注释、
  按 mtime **5 秒热加载**，与 Go 的 `proxyFileReload` 同值）。两个来源每次现拼，换文件不必重启。
- 走不走代理按「源/接口」门控：设置项 `proxy_enabled_sources`（`novel_a` 整源 /
  `novel_a/chapter` 单接口，留空 = 不限制）。**scope 由派发层传**（`createFetchFacade(upstream, {source, action})`），
  别让 Upstream 自己去拆 URL——那是第二份"谁在调"的事实。
- 选择是**轮转**（Go 是随机）：分摊更均匀，单测也不抖。差别只影响"被同一个 IP 盯上"的概率，
  换来可复现；真要按 Go 的随机改，只改 `nextProxy()` 一处。
- UA 轮换池与 Go 的 `base/proxy.go:userAgents` **逐条一致，12 条，一处定义**
  （`kernel/src/upstream.ts` 的 `UA_ROTATE`）。源显式给了 `User-Agent` 就不覆盖。

链的顺序（`docs/架构/弹性获取栈与环境变量.md` 是正本）：缓存 → 合并（singleflight）→
熔断（按 host）→ 代理池/直连 → 上游。上游缓存键：

- `FetchJSON`：`"json:" + url + headersKey(headers)`
- `FetchText`：`"text:" + url + headersKey(headers)`
- `FetchShared`：调用方显式给 `cacheKey`（**空键直接 500**，不猜）；POST 的键必须含会话维度，
  成败判定归调用方（`cacheIf` 返回 false 就不缓存）。

TS 对应：`undici` + `AbortSignal.timeout()`；`headersKey` 保持"排序后的 k=v 拼接"的同一种算法，
否则双跑时缓存命中率对不上（对拍会把"缓存没命中"表现成"两次上游响应不同"）。

## 7. 号池（`base/pool/`）

```ts
Provider = {
  name(): string
  create(ctx): Device                        // 只建号不领取
  refresh(ctx, dev): Quota                   // 拉台账，不领取
  claim(ctx, dev): void                      // 领取/续期，**必须叠加无损**
  // 可选
  isResourceExpired?(err): boolean           // 501 一类"资源到期"不算限流信号
}

Device = { ident: string, attrs: Record<string,string>, payload?: unknown, quota: Quota }
Quota  = { total: number, used: number, expiresAt: Date }
// exhausted = used >= total；remaining = expiresAt ? expiresAt - now : 0

Config = { coldSpares, maxHot, maxDead, maxDevices, kind, targetDevices,
           cooldownDefault, renewBefore, interval, hookTimeout }
Kind   = "" | "burn_wall_clock" | "spread"
```

状态机（`models.PoolDevice.status`）：`hot / cold / spent / dead / cooldown`。
- `promoteLocked` 的硬门槛：**refresh 失败→dead、exhausted→spent、临期→claim**，
  claim 失败也→spent。所以"claim 接口坏了"的症状是 **hot 永远是 0**（xmly 2026-11 现场）。
- `spread` 型（用量摊薄）不 claim、不探活，靠业务侧 `Cooldown(ident, until, reason)` 上报。
- 持锁调钩子必须带截止（`HookTimeout`，默认 30s）：不读 ctx 的 Provider 拦不住挂住的上游。

`Status`（`GET /admin/pools` 的 `data`，面板读它）：

```jsonc
{ "name":"xmly", "running":true,
  "config":{ "cold_spares":2,"max_hot":3,"max_dead":10,"dead_retention":10,"max_devices":0,
             "kind":"","renew_before_sec":300,"maintain_sec":60 },
  "counts":{ "hot":1,"cold":2,"spent":5,"dead":0,"cooldown":0 },
  "devices":[{ "ident":"…","creds":["device_sn"],"payload_keys":[],"status":"hot",
               "note":"","total_quota":4,"used_quota":4,"expire_at":"2026-10-27T00:09:01+08:00" }],
  "soft_deleted":0 }
```

凭证**只列键名不列值**（`creds`/`payload_keys`）。这条是安全属性，TS 版要用用例钉住。

## 8. 观测（`base/subject.go` + `models/api_call_log.go`）

```jsonc
// CallSubject（进程内，不落库原样）
{ "keyword":"…","book_name":"…","chapter_title":"…","media":"novel","result_count":12,
  // 以下 json:"-" 或单独落库
  "in_band_error":false,"in_band_reason":"","in_band_code":"",
  "book_key":"…","chapter_key":"…","content_withheld":false }
```

抽取规则（`legado.ObserveCall`）：`bookList`→搜词+书名灌缓存；`bookInfo`→书名/媒介；
`chapterList`→条数；正文→`contentType` 判媒介、`content` 非空记 1。**空串 = 没抽到，不是错误。**

**阅读记录（书名/章节名）靠「标识 → 名称」缓存跨请求接续**，这是三处实现，少一处就只剩详情页有书名：

1. **攒名字**：`bookList` 里每一条都进缓存（用户接下来点的就是其中一本）；`chapterList` 里每一条
   章节名进缓存。章节键必须是 **`书标识|章标识`** 的复合键——章节标识多数只在书内唯一，
   只用 itemId 会把 A 书的第 3 章标题填进 B 书（`name_cache` 的拼法只有一处）。
2. **回填**：正文/目录请求通常只带 `bookId/itemId`，抽取末尾按标识回查，把书名/章节名补进
   subject（`book_ident/chapter_ident` 也取 subject 里的键，不直接抄请求参数）。
3. **落库后回填**：`POST /admin/monitor/backfill-subjects` 按缓存补齐历史行里空着的名称
   （键的拼法与第 1 步一致，分家就等于"缓存有值、明细分永远空"）。

**留存同意位是最后一道闸**：用户关掉留存时，抽取照跑（成没成要留在读数里），
但① 命名缓存写口一律跳过（否则"当场说不捕获、下一轮被自己补回来"），
② 写明细前 `withholdContent()` 把搜索词/书名/章节名/媒介/计数与两个标识一起抹掉，
`content_withheld=1` 让"本人关掉"与"没抽到"分得开。

**榜单口径（管理端与公开榜共用一份聚合）**：`visitors` 是同数据源内按访问者去重的**人数**
（注册用户按用户名，匿名退到 IP，跨源相加不再去重），`requests` 是调用条数；
书名维度的排名数字取**人数**（一条正文明细只是一章，按次数排等于把"谁在读"写成"被翻了多少章"），
其余维度取条数；成功率与平均耗时一律按请求算。`book/chapter` 两个维度只统计 `content`。

媒介这一格不是“能抽到就抽到”的尽力而为，而是一条**判定链**（优先级从高到低）：
① 响应自带（条目的 `bookTypeCode` / 详情的 `bookType` / 正文的 `contentType`）
→ ② 请求 tab 命中的源声明（`SearchTab.media_type`）
→ ③ 命名缓存里这本书此前的判定（本仓 `name_cache` 不存媒介，暂缺）
→ ④ 源默认声明（`SourceMeta.media_type`）→ ⑤ 空串（未判定）。
缺了 ②④ 不会报错但会骗人：单媒介源（声明了 `media_type`）的搜索响应里没有条目类型字段，
明细/筛选/覆盖率/内容榜就会整天显示“未判定”。用例在 `packages/source-kit/test`。

额度侧落库（本分支新增，Go 版同名表）：`quota_limits(plan_id, scope, target, "limit")`、
`user_quota_overrides`、`quota_usage_logs(user_id, username, group_code, interface, cost, created_at)`、
`quota_costs(group_code, interface, cost, status, interval, limit_count, window_sec)`。

落库字段（`api_call_logs`）：`username, ip, source, action, status, in_band_error,
in_band_reason, in_band_code, latency_ms, created_at, keyword, book_name, chapter_title,
book_ident, chapter_ident, media_type, result_count, content_withheld, **plugin_version**`
（最后一格是 ④ §7 批准的：热更新之后要能按版本切分读数；空 = 非插件路径/旧行）；
聚合归档表 `api_call_stats(source, action, total, success, failed, total_latency_ms, max_latency_ms)`。

两个消费端的形状（回裸数组会让整段空白）：

```jsonc
// GET /admin/monitor/subjects?dim=keyword|book|chapter|media&days=7&source=&media=
{ "dim":"book","days":7,"from":"<窗口起点 ISO>",
  "items":[{"name":"…","total":1,"visitors":1,"requests":2,"success":2,"failed":0,
            "success_rate":100,"avg_latency_ms":484,"max_latency_ms":534,"empty_results":0,
            "sources":["fq_novel"],"last_called_at":"…","book_id":"…"}],
  "coverage":[{"source":"…","action":"content","rows":2,"has_book_name":2,"has_book_ident":2,
               "has_chapter_title":2,"has_media":2,"failed":0,"in_band_failed":0,
               "withheld":0,"expect_book":true}],
  "coverage_error":false, "name_cache":{"books":10,"chapters":104} }

// GET /rank/boards?days=1|7|30&source=&media=（登录用户；白名单 rank_public_sources 留空=普通用户 403）
{ "days":7,"limit":20,"source":"","unrestricted":false,
  "boards":[{"dim":"keyword","title":"搜索热词榜","unit":"次","metric":"搜索次数","rows":[{"name":"…","total":3}]},
            {"dim":"book","title":"阅读榜","unit":"人","metric":"访问人数（同数据源内按用户去重）",
             "rows":[{"name":"…","total":1,"book_id":"…"}]}],
  "sources":[{"code":"fq_novel","name":"番茄小说"}],
  "medias":[{"value":"novel","label":"小说"}],"cache_ttl_sec":60 }
```

公开榜**只给名称/次数（阅读榜另给 `book_id`）**：明细含用户阅读行为，成功率/耗时/来源/时间
那一套排障字段只在管理端那张榜上。

`content_withheld` 的语义是"**用户自己关掉了留存**"，不是"没抽到"——两个"全空"必须分得开，
否则覆盖率读数会替用户的选择背锅。`WithholdContent()` 要连 `book_key/chapter_key` 一起清
（否则回填循环下一轮会把它补回来）。

## 9. 配置（`conf.ConfMgr` ↔ env 键）

全部键→默认值以 `conf/conf.go` 的 `Load()` 为唯一真源。迁移时的三条硬规矩：

1. **默认值不许改**（改了 `AuthWhitelist` 默认值 = 安全口径变化；改了 `TZ_OFFSET_HOURS` = 日界错位）。
2. **读键的地方只有一处**（`packages/kernel/src/config`）：Go 版 `config-wired-check` 就是钉
   "字段声明了但装配块没写"这条（P124 的 `RANK_CACHE_SEC` 事故）。
3. **源专属键不进 `conf/`**：`XMLY_*`、`FQHG_*` 等由源包自读；号池运行参数才走 `POOL_*`。

主要键一览（分组）：

| 组 | 键 |
|---|---|
| 超时/缓存 | `TIMEOUT_CONNECT=5` `TIMEOUT_POOL=10` `CACHE_TTL=300` `CACHE_MAXSIZE=128` `UPSTREAM_CACHE_TTL=10` `UPSTREAM_CACHE_MAXSIZE=512` `UPSTREAM_CACHE_STALE_MULT=3` |
| 熔断/代理 | `CIRCUIT_BREAKER_ENABLED=true` `CIRCUIT_BREAKER_FAILURES=5` `CIRCUIT_BREAKER_COOLDOWN=30` `UPSTREAM_PROXIES` `UPSTREAM_PROXY_FILE` `UPSTREAM_UA_ROTATE=false`。**未实现**（Go 有、TS 没有，别配也别写进示例）：`UPSTREAM_PROXY_API*` 动态代理、代理三连败封禁 60s、代理失败换一个再回退直连重试 |
| 服务 | `SERVER_HOST=0.0.0.0` `SERVER_PORT=8081` `SERVER_LOG_LEVEL=info` `TZ_OFFSET_HOURS=8` `ERROR_CODE=-1` `DATA_DIR=data` `DATA_FILE_GLOB=*.json` |
| 监控/计费 | `MONITOR_RETENTION_DAYS=0` `MONITOR_BACKFILL_SEC=900` `BILLING_DEDUPE_SEC=300` `RANK_CACHE_SEC=60` |

计费口径（2026-11-18 明确，两个都踩过）：

- **只有"有账号且成功且非带内失败"才进 `quota_usage_logs`**；匿名（含 env 静态键）不归属任何账号，
  不计费——这与 Go 同口径（匿名那一档只有 IP 可数）。
- **成本行是计费的开关**：`quota_costs` 里没有 `(源码, 接口)` 那一行 = `cost=0` = 不计费、流水永远空。
  所以成本行必须在**插件生效时**登记（`SourceHost` 的 `onPluginActive` 钩子 → `ensureDefaultCosts`），
  启动扫描与运行期「安装插件」走同一条；只写在装配期的扫描循环里，就会出现
  "启动时装好的源计费、后装的源免费"（现场 2026-11-18：管理员看板恒 0）。
- 与 Go 的唯一有意偏离：Go 的 `billingEnabled() = AUTH_ENABLED`，`AUTH_ENABLED=false` 的开放部署
  **完全不记**用户级消耗；本仓把额度域当正式功能，登录用户照记（否则看板/套餐/流水在默认配置下全空）。
| 鉴权 | `AUTH_ENABLED=false` `API_KEYS` `AUTH_WHITELIST=/,,/data,/auth/register,/auth/login,/panel` `JWT_SECRET` `JWT_EXPIRE_HOURS=168` `ADMIN_USERNAME` `ADMIN_PASSWORD` |
| DB/Redis | `DB_TYPE=mysql` `DB_HOST/PORT(3306)/USER/PASSWORD/NAME/SSLMODE` `REDIS_ENABLED=true` `REDIS_HOST/PORT(6379)/PASSWORD/DB(0)` |
| 号池 | `POOL_ENABLED=true` `POOL_COLD_SPARES=2` `POOL_MAX_HOT=3` `POOL_MAX_DEAD=10` `POOL_RENEW_BEFORE_SEC=300` `POOL_HOOK_TIMEOUT_SEC=30` `POOL_MAINTAIN_SEC=60` `AGGREGATE_PER_SOURCE_MAX=4` |
| 部署历史 | `RETIRED_SOURCES`（逗号分隔，启动期清理存量行） |

`.env` 加载两条语义必须保留：**已存在的真实环境变量优先**（不覆盖）、值两端引号被剥离。
`AUTH_ENABLED` 读不出来的当年症状是"以为开了鉴权"——所以非法值要出声（`badEnvNotes`）；
**读了却不用**是同一个病的另一半：`true` 时数据面必须真的 401（白名单路径除外），
`false` 时也不是"全放行"——匿名仍要过免费套餐（`code='free'` 的套餐里有没有该源那一行）。

匿名档与"新接入的源"：内置套餐的每源默认档是 `free=100 / vip=1000 / admin=-1`
（`packages/store/src/seed.ts` 的 `BUILTIN_PLAN_LIMIT_DEFAULTS`，与 Go 同名表同值）。
**只在新接入源时补授权行**（装配期按 `data_sources` 的新增集合差），已存在的源哪怕管理员
删掉了授权也不复活——"删了又自己回来"是面板上最说不清的一格。

## 10. 注册与启动时序（源能"自注册"的机制）

```
包 init()            → base.RegisterSource(SourceMeta{...}) + base.Register(constructor...)
conf.Load()          → 读 .env、逐键 setenv
db.Init()            → 建表/迁移、seed data_sources、落 SourceMeta.Settings 行、登记敏感键
RunSourceBoots()     → 逐源 OnBoot（幂等；失败只记日志）
pool.StartAll()      → 各源登记过的号池启动（hot/cold 装载 + 维护协程）
registerHandlers()   → 遍历 base.All() 建路由 + middleware 链
listen（socket activation 优先）→ 预热缓存 → 维护协程
```

TS 插件化的时序（所有都在 `apps/server`，且 `reload` 走同一段）：

```
config  →  store.init（建表/迁移）
        →  source-host.scan(plugins/) → 逐插件 load（manifest 校验 + import + 声明落地 + onBoot + 登记池）
        →  pool.startAll（只启动已登记且 enabled 的）
        →  api.mount（静态路由 + catch-all 派发器）
        →  listen（socket activation 优先）→ 预热 → 维护协程
```

注册期禁用形态一律 `log.Fatalf`（不要绕过）：重名源、空 `code`、空 `actions`、非法 `media_type`、
非法 setting `type`、重复 middleware `Order`。**"带病装配不如启动失败"** 是这套东西的安全属性。

TS 版对应：`packages/source-kit` 导出 `defineSource()`，在模块顶层调用即完成登记；
zod 的 `.parse()` 失败抛错 → `apps/server` 启动阶段 catch 后 `process.exit(1)`
（**不要**降级成 warn，否则"少一个源"会变成运行期 404）。
**唯一的例外**：运行期 `reload` 失败不退出进程，只把该插件标 `failed` 并保留老代（④ §10 矩阵）。

## 11. TS 侧命名与类型约定

| Go | TS | 理由 |
|---|---|---|
| `map[string]interface{}` params | `Record<string, string>` | 值永远是字符串；`__uid` 是数字例外 → `Params` 类型里显式加 `__uid?: number` |
| `*int`（`BookTypeCode`） | `number \| undefined` | 缺失 ≠ 0，别用 0 兜底 |
| `json:"..."` 标签 | zod `.describe()` + `z.infer` | 单一真源；生成 OpenAPI/前端类型 |
| `omitempty` | `undefined`（不是 `null`） | `JSON.stringify` 会跳过 undefined |
| `time.Time` | ISO8601 带位移字符串（`+08:00`） | 面板直接渲染；Go 的 RFC3339 同形 |
| `context.Context` | `AbortSignal` + 显式 deadline | 取消语义必须能传进 fetch |
| `error` | `class UpstreamError extends Error` + `cause` | 迁移时保持 `instanceof` 判据，别退成字符串匹配 |
| 枚举常量 | `as const` 数组 + `z.enum` | 值域校验与声明位共用一份 |

**不要做**：把 `bookId` 改成 `book_id`、把 `sources_status` 改成 `sourcesStatus`、
把 DTO 换成 class（`JSON.stringify` 结果就会带方法/原型差异，对拍和下游都会炸）。