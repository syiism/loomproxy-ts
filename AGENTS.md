# AGENTS.md — loomproxy-ts 分支的执行纪律

> 本分支是 Go 版 LoomProxy 的 TS 重写（孤儿分支，无 Go 代码）。
> 设计与字段正本在 `docs/方案/迁移-TS-{1..4}.md`；**代码与那四页冲突时改代码并回写那四页**。

## 1. 硬约束（违反即回滚，不讨论）

1. **不许出现 Go 代码**：`tools/check-layers.mjs` 会扫全树，`.go` 文件当场红。
2. **依赖只许向下**：`contract → kernel → store/source-kit → gate/source-host → api → apps/server`。
   新增包先在 `tools/check-layers.mjs` 的 `LAYER`/`ALLOW` 里登记，再写代码。
   `source-kit` **不许 import store**（设置走注入的 `SettingsReader`）；`api` **不许 import 具体源包**。
3. **契约不许漂**：数据面是裸对象（不加 `code/msg`）、控制面 `{code,msg,data}`、
   `omitempty` → `undefined`（不是 `null`）、字段名逐字照抄。改任何一条都算破坏前端（① §1）。
4. **Node strip-only 语法**：不用 `enum` / `namespace` / 构造器参数属性 / 装饰器。
   类型导入一律 `import type`（`verbatimModuleSyntax`）。
5. **源包实现暂不做**：本轮只用 `packages/source-host/test/fixtures/*` 的夹具验证宿主；
   真源落地时按 ④ §3 的插件包形状（一源一包、manifest 是唯一声明位）。

## 2. 改完必须跑

```bash
pnpm run check     # 分层 + tsc + 全部用例
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
| `apps/server` | `compose()` 起得来：无插件目录也能起，有插件立即可派发 |

## 4. 写代码的约定

- **凡是"一处事实"的东西只留一处**：分页夹（`kernel/paging`）、时区日界（`kernel/clock`）、
  设置类型（`contract` 的 `SETTING_TYPES`）、缓存键含"这条响应属于谁"。
- 缓存键必须含身份维度；插件换代必须 bump `registry.generation`（并进 `/datasources` 缓存键）。
- 上游请求只走 `ctx.fetch`（源）或 `Upstream`（平台）：不许自建 `undici` 实例，
  否则绕开熔断/代理/共享缓存/合并。
- 错误文案外发前必须脱敏：`?query` 整段替换（`scrubQuery`）、带内 `message` 走 `sanitizeUpstreamMsg`。
- 定时器/监听器一律登记到 `ShutdownRegistry`（SIGTERM 时统一收）。
- 注释写"为什么"，不写"做了什么"；踩过一次的坑写成用例或 `check-layers` 规则，不要只写进注释。
