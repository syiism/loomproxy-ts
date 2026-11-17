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
apps/server         L5  进程入口（compose → listen → 停机），装配顺序的唯一出处
```

依赖矩阵与禁反向依赖的规则在 `tools/check-layers.mjs`（`pnpm check:layers`）。

## 命令

```bash
pnpm install
pnpm run check        # = 分层检查 + tsc 类型检查 + 全部用例（node --test）
pnpm run check:layers # 只看依赖方向（顺带断言树里没有 Go 代码）
pnpm run check:types  # tsc -p tsconfig.json（noEmit）
pnpm test             # 35 个用例，不连网、不连 DB
pnpm dev              # 起服务（读 .env，PLUGIN_DIR 默认 plugins/）
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
| 源包实现（36 个） | ⛔ 本轮不做（`source-host` 用测试夹具验证） |
| drizzle/sqlite 持久化（设置、data_sources、明细、号池表） | ⛔ 未接（`store` 现为内存实现） |
| worker 隔离模式、号池运行时、面板静态托管、socket activation | ⛔ 未接（设计见 ④ §2/§8、③ §9） |

## 边界

- 插件 = 任意代码执行：只从本地受信目录加载，**不提供从 URL 安装**（④ §9）。
- 契约不许漂：数据面裸对象、控制面 `{code,msg,data}`、`/datasources` 字段名都与 Go 版逐字一致；
  双跑对拍方法见 ① §8。
