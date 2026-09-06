---
description: "ctx.web 的 Obscura 抓取提供方：经由自托管单二进制头less浏览器的反检测页面渲染，用原始状态探测保持 statusCode 真实。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-fetch-obscura

[English](README.md) | 中文

## 概述

有了 `dsh-web-fetch-obscura`，harness 可以通过自托管的 [Obscura](https://github.com/h4ckf0r0day/obscura) 头less浏览器抓取 URL——单个 Rust 二进制，带 V8 渲染与内建反检测，无需安装浏览器、无需托管环境。当页面封锁纯 HTTP 客户端或需要 JavaScript 渲染、且部署更倾向自托管而非付费托管抓取服务时选择它。每次抓取先运行原始状态探测，再运行渲染导出，使 `web_fetch` 的输出携带 Obscura 的 markdown/text/html 以及真实的 HTTP 状态。面向模型的 `web_fetch` 工具位于 `dsh-tool-web`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `obscura` 抓取提供方身份注册，因此当它是唯一可用的抓取后端时，`ctx.web.fetch()` 会自动解析到它——也可以用 `fetchProvider: obscura` 固定。

### 何时选择

当部署运行 Obscura 二进制、且想要不依赖付费托管服务的反检测页面获取时选择此后端：Obscura 渲染 JavaScript、抵御反检测检查，并默认遵守 robots.txt。它是普通 HTTP 抓取器与付费托管抓取器之间的自托管中间层。当配置的可执行文件缺失时，本提供方不可用——每次抓取调用都会以结构化错误失败。

### 最小配置

将 Obscura 安装到 harness home 下（默认位置），或把 `commandPath` 指向任意 Obscura 0.2+ 发行版二进制：

```sh
# release asset: obscura-<platform>-stealth.zip
mkdir -p ~/.dsh/tools/obscura
unzip obscura-x86_64-windows-stealth.zip -d ~/.dsh/tools/obscura
```

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-fetch-obscura'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `commandPath` | `$DSH_HOME/tools/obscura/obscura.exe`（Windows）或 `.../obscura` | Obscura CLI 可执行文件的绝对路径；文件缺失使提供方不可用 |
| `dumpFormat` | `markdown` | 向渲染页面请求的提取格式：`markdown`、`text` 或 `html` |
| `statusProbe` | `true` | 在渲染前探测原始 HTTP 状态（见下方状态契约） |
| `maxBodyChars` | `50000` | 单次抓取返回的最大字符数 |
| `timeoutMs` | `120000` | 探测与渲染各自的最迟时限（毫秒） |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-fetch-obscura)是每个受支持字段及其 JSDoc 的穷尽来源。

### 抓取返回什么

渲染导出成为响应体：`markdown` 与 `text` 格式产生 `kind: "text"`，`html` 格式产生 `kind: "html"`，按 `maxBodyChars` 截断并置位 `truncated` 标志。`url` 字段携带引擎在重定向之后于 stderr 报告的加载后 URL（`Page loaded: <url> - ...`），因此短链接会解析到其目标地址；报告缺失时回显请求 URL。状态契约：提供方先通过 Obscura 的原始批处理路径请求 URL，该路径报告真实 HTTP 状态；非 2xx 页面（比如 404 错误页）仍会被渲染并作为携带真实状态的结果返回，与接缝“抓取到的非 2xx 资源是结果而非错误”的规则一致。当探测无法作答时——原始路径正是反检测目标最先封锁的——成功的渲染会报告 HTTP 200，因为引擎渲染出了一份确切状态无法证明的文档；若加倍请求比状态保真更重要，可设 `statusProbe: false` 跳过探测。

### 失败与恢复

失败的渲染——导航失败、CLI 非零退出、超时——以 `WebError` 冒泡：超过时限为 `OBSCURA_FETCH_TIMEOUT`，调用方取消为 `WEB_ABORTED`，其余为 `WEB_PROVIDER_ERROR`，消息中带有 CLI 的 stderr 尾部。非 http(s) 目标在任何进程启动之前即以 `WEB_INVALID_URL` 失败。探测绝不会让抓取失败：它的失败只会把结果降级到上述 HTTP 200 回退。调用方按错误码路由；面向模型的 `web_fetch` 工具在自身的错误包装下向模型呈现失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已完整覆盖于[使用本包](#use-this-package)。

### 设计原则

本提供方是 Obscura CLI 之上的薄适配器，含三条明确的规则：

- **statusCode 保持真实。** Obscura 的渲染抓取路径对浏览器能显示的任何页面都以零退出，包括 4xx/5xx 错误页，且不暴露 HTTP 状态。只做渲染就必须编造状态，因此提供方在 Obscura 的批处理路径上花费一次廉价的原始请求（每个 URL 一行 JSON 状态），并把该状态连同渲染体一并报告。
- **探测只是建议性的。** 原始路径是反检测目标最先封锁的对象，因此探测失败——封锁、超时、交换中断——只降级到文档化的回退，而不会让渲染本可成功的抓取失败。
- **单个二进制，无托管环境。** 与 Scrapling 运行时不同，这里没有需要创建或修复的 venv 流水线：可用性就是一次 `existsSync`，每个操作都是全新的短命进程。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置模式、可执行文件路径解析、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `ObscuraFetchProvider`：先探测后渲染的编排、状态契约、响应体映射 |
| [`src/runtime.ts`](src/runtime.ts) | `ObscuraRuntime`：带中止、超时与大小防护的子进程交换；探测行解析 |
| [`src/types.ts`](src/types.ts) | Obscura 批处理路径线上类型：`ObscuraProbeLine` 与导出格式 |
| — | 不发布运行时不变量伴侣；本包在自有接缝的契约之外，不暴露独立的事件序列或可变数据关系。 |

### 交换流程

`fetch()` 将目标校验为绝对 http(s)，运行探测（`fetch --quiet --file - --dump original --concurrency 1`，URL 走 stdin，返回一行 JSON 状态），随后运行渲染（`fetch --quiet --dump <format> --timeout <s> <url>`，导出走 stdout）。两者都在 `dsh-timeout` 时限下运行并传播调用方中止的进程终止信号，渲染结果被截断并打标。渲染失败抛出；探测失败只降级状态。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够时阅读这些页面。它们从共享词汇延伸到服务、面向模型的工具与设计依据。

- [Web 子系统](../../../docs/subsystems/web.zh.md) — 穷尽的抓取请求/结果词汇与错误码。
- [Web 包地图](../README.zh.md) — web 包家族与各自角色。
- [dsh-web](../web/README.zh.md) — 本提供方注册进的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md) — 渲染本提供方响应体的面向模型 `web_fetch` 工具。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-fetch-obscura) — 每个受支持配置字段及其来源声明。
- [Web 能力接缝决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md) — 搜索与抓取为何共享一个提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-web`：它保留本提供方渲染的 markdown/text/html 响应体、`Fetched <url> (HTTP <status>)` 头中探测到的 HTTP 状态、`truncated` 标志，以及其在消费方错误包装下呈现的 `Obscura fetch timed out after <ms>ms`、`Obscura fetch failed with exit code <code>: <stderr tail>` 等失败原文。

#### KV 缓存影响

无直接失效；请求前缀的变化由具名消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义了本提供方何时是糟糕选择。它们是当前的包约束。

- **状态的真实性取决于探测** — 当原始路径被封锁而渲染成功时，无论页面真实状态如何，结果都报告 HTTP 200；`statusProbe: false` 会把这一情形扩大到每次调用。
- **正文提取仅限 Obscura 的导出格式** — 不暴露 CSS 选择器作用域、页面截图、PDF 导出或 CDP/浏览器控制面；那些属于浏览器自动化接缝，而非本接缝。
- **最终 URL 检测读取 CLI 的 stderr 报告** — 当目标页面在加载 URL 行打印之前以脚本噪音淹没 stderr 时，结果回退到回显请求 URL；渲染内容不受影响。
- **探测开启时每次抓取两次进程启动** — CLI 本身很快，但时延敏感的部署可能更愿意对未被封锁的页面使用 `statusProbe: false` 或普通 HTTP 抓取器。
- **超时秒数按交换计算** — 探测与渲染各自获得完整的 `timeoutMs`，因此最坏情况下一次抓取会占用两倍时限。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

本开发备注是维护者的工作背景：开放问题与未定方向。它明确地不具权威性——已交付的行为、限制与依据以上文及链接的 Agent Note 为准。

#### 未来：跨抓取提供方的回退链

预期的部署形态是一个路由层——普通 HTTP，其次对被封锁页面使用 Obscura，再次为托管抓取器——它等待 web 服务中的提供方中立路由字段，而非各提供方各自为政。与接缝 Agent Note 中搜索路由方向一并跟踪。

</details>
