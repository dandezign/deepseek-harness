---
description: "ctx.web 的 Firecrawl 搜索提供方：开箱即用的无密钥搜索，配置密钥解锁更高限额，一个适配器兼容两种响应信封。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-firecrawl

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-firecrawl`，harness 可以通过 Firecrawl 搜索 web，获得以 Firecrawl 结果描述作为 snippet 的来源。当部署想要零配置的搜索时选择它：空密钥以无密钥模式运行，受 Firecrawl 的无密钥速率限制；配置密钥则解锁更高限额。Firecrawl 不返回生成答案，因此结果不携带 `content`——只产出可引用的来源。条目自身及其元数据都没有 URL 时会被丢弃，因此一次调用返回的来源可能少于请求数量。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

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

在已加载 web 服务的组合中挂载本提供方；它以 `firecrawl` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: firecrawl` 固定。

### 何时选择

当部署想要无需账号的搜索时选择此后端：本提供方以无密钥方式工作——`Authorization` 头被完全省略——而 Firecrawl 以速率与并发而非拒绝服务来约束无密钥流量。配置密钥可抬高限额。由于无密钥模式始终可用，把本提供方与另一个搜索提供方同时挂载会使两个提供方同时可用；必须显式固定其一，否则接缝会以 `WEB_PROVIDER_AMBIGUOUS` 大声失败。

### 最小配置

加载 web 服务与本提供方；每个设置都有安全默认值，密钥在存在时回退到启动环境中的 `$FIRECRAWL_API_KEY`。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-firecrawl'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `$FIRECRAWL_API_KEY` | Firecrawl API 密钥；为空则以无密钥模式运行（不带 `Authorization` 头，受无密钥速率限制） |
| `baseURL` | `https://api.firecrawl.dev` | 端点基址；`/{version}/search` 会被追加。无法解析的值使提供方不可用 |
| `apiVersion` | `v2` | 追加到端点基址的 API 版本：`v1` 或 `v2`；两者的响应信封不同，但都被接受 |
| `numResults` | （未设置） | 请求不带 `maxResults` 时的默认结果数；必须为正整数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-firecrawl)是每个受支持字段及其 JSDoc 的穷尽来源。

### 搜索返回什么

每条 Firecrawl 结果映射为一个 `WebSearchSource`：`description`/`snippet`/`metadata.description` 中第一个非空白者作为 `snippet`，URL 取自条目本身或其元数据；任何位置都没有 URL 的条目会被丢弃。Firecrawl 不返回生成答案，因此结果不携带 `content`。请求的 `maxResults` 优先于配置的 `numResults` 默认值；最终界限由 web 服务执行。

### 失败与恢复

提供方失败——HTTP 错误、网络失败、无法解析或形状错误的响应体，以及 `success: false` 信封——以 `WebError` `WEB_PROVIDER_ERROR` 冒泡；被中止的请求以 `WEB_ABORTED` 冒泡。HTTP 重定向在联系 `Location` 目标之前即被拒绝，并以 `WEB_PROVIDER_ERROR` 冒泡，因此配置的凭据与 POST 请求体绝不会被转发到另一个源。调用方按错误码路由；面向模型的 `web_search` 工具在自身的错误包装下向模型呈现失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已完整覆盖于[使用本包](#use-this-package)。

### 设计原则

本提供方是 Firecrawl API 之上的薄适配器，含三条明确的规则：

- **无密钥是一等模式。** 空密钥完全省略 `Authorization` 头——绝不发送空凭据——可用性只取决于端点本身，因为无密钥正是部署获得零配置搜索的方式。
- **一个适配器，两种信封。** Firecrawl v1 返回扁平的 `data` 数组而 v2 返回 `data.web`；映射器同时接受两者，使指向自托管或旧版本部署的 `baseURL`/`apiVersion` 组合持续可用。
- **只做可移植 snippet。** 来源的 `snippet` 来自 Firecrawl 的描述字段；无 URL 的条目被丢弃而不是编造地址。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置模式、环境变量回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `FirecrawlSearchProvider`：请求分发、中止分类、信封处理、结果映射 |
| [`src/types.ts`](src/types.ts) | Firecrawl 线上类型：`FirecrawlSearchResponse`、`FirecrawlSearchItem` |
| — | 不发布运行时不变量伴侣；本包在自有接缝的契约之外，不暴露独立的事件序列或可变数据关系。 |

### 请求与映射流程

`search()` 向 `{baseURL}/{version}/search` 发送查询、结果数与 web 来源列表，采用 `redirect: 'error'`，使重定向在联系目标之前即告失败。解析出的 web 结果列表逐条映射，无 URL 条目被丢弃，服务在返回路径上执行最终的 `maxResults` 界。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余一切变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够时阅读这些页面。它们从共享词汇延伸到服务、面向模型的工具与设计依据。

- [Web 子系统](../../../docs/subsystems/web.zh.md) — 穷尽的搜索请求/结果词汇与错误码。
- [Web 包地图](../README.zh.md) — web 包家族与各自角色。
- [dsh-web](../web/README.zh.md) — 本提供方注册进的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md) — 渲染本提供方来源的面向模型 `web_search` 工具。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-firecrawl) — 每个受支持配置字段及其来源声明。
- [Web 能力接缝决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md) — 搜索与抓取为何共享一个提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-web`：它保留本提供方的 URL、标题、snippet，以及其在消费方错误包装下呈现的 `Firecrawl search aborted`、`Firecrawl search request failed: <error>`、`Firecrawl search was unsuccessful: <reason>`、`Firecrawl returned an unprocessable response body: <error>` 等失败原文。

#### KV 缓存影响

无直接失效；请求前缀的变化由具名消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义了本提供方何时是糟糕选择。它们是当前的包约束。

- **任何位置都没有 URL 的条目被整体丢弃** — 没有可引用地址，因此返回的来源可能少于请求数量。
- **无密钥流量受 Firecrawl 的速率与并发限制** — 重度部署使用需要配置密钥；每月免费的无密钥/搜索额度有上限。
- **不请求内容提取** — 本提供方只向 Firecrawl 请求结果列表，因此结果不携带页面 markdown；页面正文请使用抓取提供方。
- **仅暴露 `apiVersion`/`numResults`** — Firecrawl 的其他控制（分类、时间范围、抓取选项）等待提供方中立的服务字段（[接缝 Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **中止分类基于错误形状** — 只有名为 `AbortError` 的 `DOMException` 映射为 `WEB_ABORTED`；携带自定义原因的中止（如 `dsh-timeout` 的 `TimeoutReason`）以 `WEB_PROVIDER_ERROR` 呈现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

本开发备注是维护者的工作背景：开放问题与未定方向。它明确地不具权威性——已交付的行为、限制与依据以上文及链接的 Agent Note 为准。

#### 未来：更宽的 Firecrawl 控制面

Firecrawl 的分类、时间范围与内联抓取选项暂不暴露。暴露它们需要先有提供方中立的服务字段，因此本家族会以一次协调的变更增加一个控制项，而不是某个厂商特有的参数。

</details>
