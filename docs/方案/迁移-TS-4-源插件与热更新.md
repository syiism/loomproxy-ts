# 迁移 TS ④：源做成插件包与热更新

> 需求一句话：**加源 / 更新源 / 下线源都不重启进程**，在飞请求不中断，坏插件不拖垮服务。
> 这一页只回答"怎么做"，契约面见 [`迁移-TS-1-接口契约.md`](迁移-TS-1-接口契约.md)（对外 URL 不变），
> 字段协议见 [`迁移-TS-2-base字段协议.md`](迁移-TS-2-base字段协议.md)（声明位变成运行期 manifest），
> 分层见 [`迁移-TS-3-漏斗分层与包边界.md`](迁移-TS-3-漏斗分层与包边界.md)（新增 L3 `source-host`）。

## 1. 先把"热更新"定义清楚

| 动作 | 今天的 Go | 目标 |
|---|---|---|
| 加源 | 改 `deploy_all.go` 空白导入 → 重编译 → 重启（restart 期间靠 socket activation 排队） | 插件目录里多一个包 → `POST /admin/sources/reload` 或 fs 变更自动检测 → 秒级可用 |
| 更新源 | 同上，且**必须整进程重启** | 原子换到新一代，在飞请求走完老代 |
| 下线源 | 摘导入 + `RETIRED_SOURCES` + 重启 | 标记 disabled（**不删行**，历史额度/配置保留）或卸载 |

三条硬判据（不然"热更新"只是"少重启几次"）：

1. **原子性**：切换瞬间不允许出现"一半请求打到新代、另一半打到不存在的老代"。
2. **可回滚**：新代健康检查不过 → 自动留在老代；手动 `rollback` 能回上一个版本。
3. **隔离**：一个插件加载失败/崩溃/死循环，其它源照常服务。

## 2. 两种隔离模型（必须选一个，混合也行）

| | A. 进程内 ESM 动态加载（默认） | B. 每插件 `worker_threads`（可选） |
|---|---|---|
| 代码卸载 | **不能**（`import()` 进模块缓存后无法回收）→ 用 `?v=<version>` 缓存破坏导入新代，老代留在内存 | `worker.terminate()` 真卸载 |
| 切换成本 | 毫秒级（一次 `import()`） | 十毫秒级（起线程 + 预热） |
| CPU 重活（解密/大 JSON/cheerio） | **卡主线程**（全站 P99 抖） | 天然隔离 |
| 崩溃/死循环 | 拖垮整个进程 | 只死一个 worker，可超时终止 |
| 共享取数栈 | 直接共享（单例，最省） | 必须 RPC 回主线程（见 §8） |
| 内存 | 每次更新留一代（模块 + 包级缓存），有界但不回收 | 每插件常驻一个线程（约 30–50MB），36 源全常驻 ≈ 1–2GB |
| 适用 | 自有、受信、逻辑轻的源（今天 36 个源的多数） | 重解析/重解密源（`zj_novel`）、第三方插件、可疑插件 |

**默认 A，manifest 里可选 `isolation: "worker"`**。理由：自有源受信、36 个源常驻线程的内存代价不可接受、
而 A 的唯一真代价（不回收）在"偶尔更新"的频率下是有界的。A 的前提取决于一条实现约束：

> **注册表必须在每次请求时解析，不许在路由注册时把 handler 闭包捕获下来。**
> 否则换代之后老闭包还在跑——热更新变成"看起来生效、实际一半请求打老代码"。

B 的故障面（事件循环阻塞）与热更新的需求共用同一个边界，所以留成可选项即可，不必全量上。

## 3. 插件包形态

```text
plugins/
  fq_novel/
    1.4.2/                     # 版本化目录：回滚 = 指回上一个版本
      package.json
      manifest.json            # = SourceMeta（② §2 的 JSON 形态）+ 插件元信息
      dist/index.js            # 入口（ESM）
    1.5.0/
  zj_novel/
    ...
```

```jsonc
// package.json
{ "name": "@loomproxy/source-fq_novel", "version": "1.5.0", "type": "module",
  "exports": { ".": "./dist/index.js" },
  "peerDependencies": { "@loomproxy/source-kit": "^1" } }   // ← 必须是 peer，见下
```

```jsonc
// manifest.json：声明位（② §2）+ 三格插件元信息
{ "code": "fq_novel", "display": "番茄（小说）", "actions": ["search","detail","chapter","content","explore"],
  "sdk_version": "^1",              // 与 host 的 source-kit API 版本比对，不符 → 拒绝加载
  "isolation": "in-process",        // "in-process" | "worker"
  "entry": "./dist/index.js",
  // 每个动作注入哪些 query（对应 Go 版 Handler.GetQueryParams）：
  // 缺省 = 该动作的标准参数集（search: key/query/page、detail: bookId …），
  // 源要用非标准参数必须显式声明——"只注入声明过的键"这条不变量靠它成立。
  "params": { "search": ["key", "page"], "content": ["bookId", "itemId"] },
  // …其余 SourceMeta 字段原样（required_params/fixed_base_url/search_tabs/media_type/settings/data_files）
}
```

三条必须写死的规则：

1. **`@loomproxy/source-kit` 只能是 peer + 由 host 提供单例**。插件自带一份 = 两个 `UpstreamError` 类
   → `instanceof` 判断全部失效（Go 版靠同一个包类型天然成立）。host 用 import map / `NODE_PATH` /
   显式 `module.createRequire` 指到 host 的副本；插件 `dependencies` 里不许出现它。
2. **`sdk_version` 语义化**：host 用 semver 校验；不兼容**拒绝加载并保留老代**，不许"尽力加载"。
3. **manifest 是声明位的唯一来源**，`index.js` 里再声明一遍 = 两份事实（Go 版的 `SourceMeta` 就是
   注册期唯一口子，这个性质要保住）。`defineSource()` 只接 handler 工厂，不再接元数据。

## 4. 加载 / 更新 / 卸载时序（蓝绿两代）

```
reload(code):
  1. 读新版本目录 → manifest 校验（zod：字段/动作集/媒介/设置类型/sdk_version）
  2. import(新 entry ?v=version) → 拿到 handlers（构造期不做 IO）
  3. 自检（可选 manifest.self_check）：拿一份内置 fixture 走一遍纯解析路径
        ├─ 失败 → 标记 failed，保留老代，返回 4xx + 原因
  4. 运行期声明落地（幂等）：upsert data_sources 行 / settings 行（只对账 type）/ 调 onBoot / 注册池
  5. **原子替换**：registry.swap(code, newGen) —— 一次 Map.set，此后所有请求读新代
  6. 老代进入 draining：等在飞请求结束（grace 30s），期间 502 分级降级（见 §10）
  7. in-process：老代无法销毁，只标记 retired（世代计数 +1，超过 N 打日志提示"该维护窗口重启了"）
     worker：worker.terminate()
```

**in-flight 不中断的机制**：请求进来时从 registry 取一次 `{gen, handler}` 并持有到结束，
所以第 5 步的替换只影响"替换之后新进来的请求"。这是整个方案里唯一不能妥协的实现细节。

**回滚**：`POST /admin/sources/:code/rollback` → 把"当前版本指针"指回上一代目录，重跑 1–5 步。
版本目录保留 N=3（可配），`rollback` 不需要重新打包（产物本来就在盘上）。

**禁用/下线**：`disabled` 只翻 `data_sources.status=0`（access 立刻 403，历史行保留）；
`unload` 才是摘注册表（此时路由变 404，等价于 Go 版摘导入 + 重启的效果，但不用重启）。

## 5. 路由与注册表（契约不变，实现变）

- 对外 URL 仍是 `/{source}/{action}`（① §5）。**实现从"启动期逐条注册"改成"一个 catch-all 派发"**：
  Fastify 里静态路由（`/datasources`、`/data/*`、`/admin/*`…）优先匹配，剩下 `/:source/:action`
  进派发器 → `registry.resolve(source, action)` → 中间件链 → handler。
- 这样"新插件刚加载就可用"是自动的，不需要 `removeRoute`/重新 `addRoute`（动态路由 API 的坑就绕过了）。
- 中间件链的判定依赖 `SourceMeta`（`RequiredParams`/`FixedBaseURL`/`AuthRequired`），
  这些在派发时从 registry 现取（**不许缓存在路由构造期**）。
- 缓存失效：`/datasources`、`/endpoints` 的响应按套餐裁剪且带缓存（Go 版键含 uid）。
  换代必须 **bump 一个全局 `registryGeneration`** 并并进缓存键（否则"加载了新源但清单里没有"）。
  这是"键少一段维度"同一个坑的新形态，TS 版要写进用例。

## 6. 运行期声明落地（对应 Go 的 `db.Init` + `RunSourceBoots`）

Go 版把声明位拆在三处（`init()` 注册 → `db.Init` 落行 → `OnBoot` 登记池）。热加载要求它们**可重入**：

| 步骤 | 幂等规则 | 失败处置 |
|---|---|---|
| `data_sources` upsert | 按 `name` upsert，**不覆盖管理员改过的 status/display/sort** | 记错、保留老代 |
| `system_settings` upsert | 行不存在才插；存在只对账 `type`，**不覆盖值**；敏感键登记进只写不回显表 | 同上 |
| `onBoot()` | 每次加载都调；插件自己保证幂等（② §2 已写） | 只记日志，插件仍可 active（Go 同口径） |
| 池登记 | `pool.register(name, provider)` 幂等；`unload` 时 `pool.unregister` 并停止维护协程 | 池不可用 → 该源内容动作返回 `pool_unavailable` 带内错误 |

## 7. 对外契约的变化点（要拍的三条）

| 变更 | 影响面 | 我的建议 |
|---|---|---|
| 新增 `GET /admin/sources/plugins`（code/version/status/isolation/generation/inflight/last_error） | 面板新增一页 | **要**，否则"加载失败"只有日志能看 |
| 新增 `POST /admin/sources/:code/{reload,rollback,disable,unload}` + `POST /admin/sources/reload-all` | 面板按钮 | **要**，这是运维入口 |
| 明细表加 `plugin_version` 列 | 观测契约（`api_call_logs` + 契约页 + 面板筛选） | **要**，且必须同批改观测契约页——否则"换了版本错误率变了"永远归因不了 |

第三条是**跨契约改动**：加列 = 改 `models/api_call_log.go` 的 JSON 列 + `docs/架构/观测契约-信封与明细字段.md`
+ 面板 history 筛选。按仓里的规矩（P127①）三处必须同一批落地，不能"先加列回头补文档"。

## 8. worker 模式下的取数栈（唯一真难点）

不能让每个 worker 各带一份代理池/熔断器（36 份状态 = 代理浪费 + 限流判定失真 + 缓存不共享）。
所以：

```
worker（插件）            ┌─ source-kit 提供的 ctx.fetch(...) ─→ RPC ─┐
  · 解析/DTO 构造                                                 │
  · 签名/加密（CPU 重活，隔离在主线程外）                            ▼
                         主线程：kernel 取数栈（缓存/合并/熔断/代理池/UA 轮换）
```

- worker 里**没有 undici 实例**，`fetch` 是 await 一个 `postMessage`；一次 RPC ≈ 亚毫秒，
  对 100ms–5s 的上游请求可忽略。
- `singleflight`/上游缓存留在主线程 → 一个源的并发合并在跨代、跨 worker 时依然成立。
- 设置项：主线程写库后 `broadcast` 到各 worker（同时 worker 侧缓存 TTL 10s，读不到就 RPC）。
- 池的 `Create/Refresh/Claim` 钩子同样经 RPC 到主线程执行（它们要发上游请求）。

## 9. 安全边界（写死，别当可选项）

- 插件 = **任意代码执行**（与 pi 的 extension 同一性质：都跑在宿主进程里）。
  所以只从**本地受信目录**加载，目录权限与进程用户一致；**不提供"从 URL 安装"**。
- 若要支持下载/第三方插件：必须签名校验 + 沙箱（worker + 禁 `fs`/`net` 直出），
  这一条单独设计，不在本次范围。生产环境的 `plugins/` 目录属主与 `loomproxy` 用户一致，写权限只给部署账号。
- manifest 校验不过、`sdk_version` 不符、目录里有符号链接越界 → 拒绝加载（Go 版 data_files 那条判据同形）。

## 10. 失败与回退矩阵

| 现场 | 处置 | 用户看到 |
|---|---|---|
| manifest 非法 / 导入报错 | 保留老代，`status=failed` + 原因 | 老代照常（新源则是 404） |
| 自检失败 | 同上 | 同上 |
| 声明落地失败（DB 写不进去） | 排序：先 upsert 再 swap；失败则不 swap | 老代照常 |
| 切换后新代立刻大量 5xx | 现有熔断（按 host）+ 手动 rollback；建议再加"换代后 60s 内错误率 > X% 自动 rollback" | 短暂抖动 |
| 老代 grace 到期仍有在飞请求 | in-process：自然结束（不 kill）；worker：`terminate()` 前再等一个 grace | 该请求可能 502 |
| worker 死循环/OOM | 看门狗：单请求超时 > `timeout_pool` → terminate + 重起一代 | 该源 502/504，其它源不受影响 |
| 插件把 `data_sources` 行改坏 | 平台不信任插件的 DB 写；插件只能通过 host API 声明 | — |

## 11. 每层怎么单独跑通（新增两格）

| 层/工具 | 判据 | 命令（拟） |
|---|---|---|
| `source-host`（L3） | 假插件（fixture 里一个最小包）：load → swap → drain → rollback 全通；坏 manifest/坏 sdk_version/导入抛错三种失败各有用例 | `pnpm -F @loomproxy/source-host test` |
| 单插件 | 不起 host 也能跑：`plugin-run ./plugins/fq_novel/1.5.0 search --query 三体 --fixture …` | `pnpm -F @loomproxy/source-fq_novel run smoke` |
| 热更新 e2e | 起真服务 → 拷一份新版本目录 → `reload` → **不重启**验证 `/datasources` 版本变了、五动作可用、老版本 grace 结束、`rollback` 回退成功 | `pnpm -F @loomproxy/server e2e:reload` |

## 12. 对迁移顺序的影响（改的是 ③ §8 的 3、6、8 步）

1. L2′ `source-kit` 从"SDK"扩展成"**SDK + 加载契约**"（manifest schema、`defineSource`、`sdkVersion`）。
2. 新增 L3 `source-host`（loader + registry + lifecycle + RPC），`api` 只依赖它。
3. 第 3 步的"2 个最简源"必须**以插件目录形态**落地（一开始就按插件包写，别先写成源码包再改）。
4. 第 6 步双跑对拍多一条：**热更新对拍**（Go 版重启一次 vs TS 版 reload 一次，对外行为相同）。
5. 第 8 步的 `server` 收尾多一条：插件目录纳入部署单元
   （`apps/server` 产物 + `plugins/` + `data/` + `.env`，与 Go 版"二进制 + data + .env"同构）。

DoD（这一条整体算完成）：**连续 reload 三次 + 一次 rollback + 一次坏插件注入，全程进程不重启、
`/datasources` 与五动作行为正确、其它源无 5xx**。

## 13. 与 Go 版的对照（为什么这件事在 Go 里做不到）

| | Go 今天 | TS 目标 |
|---|---|---|
| 装配 | `deploy_all.go` 空白导入 = 编译期决定携带哪些源 | 运行期扫 `plugins/` 目录 |
| 类型共享 | 同一个 module，`UpstreamError` 天然单例 | `source-kit` 必须 peer + host 提供单例（§3 规则 1） |
| 卸载 | 不可能（代码在二进制里） | in-process 不能真回收 / worker 可以 |
| 重启成本 | socket activation 排队，但内存态（池/缓存/熔断）全丢、要重新预热 | 只丢该源一代的内存态 |
| 风险 | 编译期全量类型检查兜底 | 运行期 manifest 校验 + 自检 + 蓝绿回滚替代编译期保证 |

**最后一句**：插件化不是"少重启"，而是把"编译期保证"换成"运行期校验 + 可回滚"。
所以 §3 的 manifest/sdk_version/peer 单例三条，和 §4 的原子替换、§10 的失败矩阵，
**是这个方案的全部成本所在**——缺一条，热更新就会变成"看起来生效"的那类问题。