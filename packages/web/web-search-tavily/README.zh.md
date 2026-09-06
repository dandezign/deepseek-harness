---
description: "ctx.web 的 Tavily 搜索提供方：部署方如何挂载 Tavily 搜索，获得生成答案、深度控制与明确的 API 上限。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-tavily

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-tavily`，harness 可以通过 Tavily 搜索 web，获得带 Tavily 提取 snippet 的来源，以及可选的、作为 `content` 携带的生成答案。当部署持有 Tavily API 密钥（存在无需信用卡的免费档）、并希望使用 Tavily 的 basic 或 advanced 搜索深度时选择它。没有 URL 的来源会被丢弃，因此一次调用返回的来源可能少于请求数量。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

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

在已加载 web 服务的组合中挂载本提供方；它以 `tavily` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: tavily` 固定。

### 何时选择

当部署持有 Tavily API 密钥、并希望获得带每条结果内容 snippet 与生成答案的 Tavily 搜索时选择此后端。Tavily 的免费 Researcher 档每月提供循环额度且无需信用卡；`advanced` 深度每次调用消耗两个额度而 `basic` 只消耗一个，因此默认深度为 `basic`。当密钥为空或端点基址无法解析时，本提供方不可用——每次搜索调用都会以结构化错误失败。

### 最小配置

加载 web 服务与本提供方；API 密钥回退到启动环境中的 `$TAVILY_API_KEY`，其余设置均有安全默认值。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-tavily'
  config:
    apiKey: !!js process.env.TAVILY_API_KEY
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `$TAVILY_API_KEY` | Tavily API 密钥；为空或缺失时提供方不可用 |
| `baseURL` | `https://api.tavily.com` | 端点基址；`/search` 会被追加。无法解析的值使提供方不可用 |
| `searchDepth` | `basic` | 作为 Tavily 的 `search_depth` 发送的检索深度：`basic`（一个额度）或 `advanced`（两个额度） |
| `includeAnswer` | `true` | Tavily 是否在结果之外生成答案 |
| `numResults` | （未设置） | 请求不带 `maxResults` 时的默认结果数；必须为正整数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-tavily)是每个受支持字段及其 JSDoc 的穷尽来源。

### 搜索返回什么

每条 Tavily 结果映射为一个 `WebSearchSource`：`url`、`title`，以及 Tavily 的 `content` 作为 `snippet`；没有 URL 的结果会被丢弃。当 `includeAnswer` 开启时，Tavily 的生成答案成为结果的 `content`（与 Perplexity 答案的待遇相同）。请求的 `maxResults` 优先于配置的 `numResults` 默认值；两者在请求层被钳制到 Tavily 文档中的 API 上限 20，而 web 服务在返回路径上仍按未钳制的界执行。

### 失败与恢复

提供方失败——HTTP 错误、网络失败、无法解析或形状错误的响应体——以 `WebError` `WEB_PROVIDER_ERROR` 冒泡；被中止的请求以 `WEB_ABORTED` 冒泡。HTTP 重定向在联系 `Location` 目标之前即被拒绝，并以 `WEB_PROVIDER_ERROR` 冒泡，因此 bearer 凭据与 POST 请求体绝不会被转发到另一个源。调用方按错误码路由；面向模型的 `web_search` 工具在自身的错误包装下向模型呈现失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已完整覆盖于[使用本包](#use-this-package)。

### 设计原则

本提供方是 Tavily API 之上的薄适配器，含三条明确的规则：

- **只做可移植 snippet。** 来源的 `snippet` 来自 Tavily 提取的 `content`；不提升其他字段，无 URL 的条目被丢弃而不是编造地址。
- **答案有标注，绝不混入来源。** Tavily 的生成答案映射到接缝的 `content` 字段，由消费方与来源列表分开渲染。
- **请求层钳制，接缝层执行。** 提供方将发出的 `max_results` 钳制到 Tavily 的 API 上限，使过大的 `maxResults` 界不会导致调用失败；服务仍按原始界截断响应。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置模式、环境变量回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `TavilySearchProvider`：请求分发、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | Tavily 线上类型：`TavilySearchResponse`、`TavilyResult`、`TavilyError` |
| — | 不发布运行时不变量伴侣；本包在自有接缝的契约之外，不暴露独立的事件序列或可变数据关系。 |

### 请求与映射流程

`search()` 向 `{baseURL}/search` 发送查询、深度、钳制后的结果数与答案请求，采用 `redirect: 'error'`，使重定向在联系目标之前即告失败。解析出的 `results[]` 逐条映射，无 URL 条目被丢弃，服务在返回路径上执行最终的 `maxResults` 界。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余一切变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够时阅读这些页面。它们从共享词汇延伸到服务、面向模型的工具与设计依据。

- [Web 子系统](../../../docs/subsystems/web.zh.md) — 穷尽的搜索请求/结果词汇与错误码。
- [Web 包地图](../README.zh.md) — web 包家族与各自角色。
- [dsh-web](../web/README.zh.md) — 本提供方注册进的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md) — 渲染本提供方来源的面向模型 `web_search` 工具。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-tavily) — 每个受支持配置字段及其来源声明。
- [Web 能力接缝决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md) — 搜索与抓取为何共享一个提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-web`：它保留本提供方的 URL、标题、snippet、生成答案，以及其在消费方错误包装下呈现的 `Tavily search aborted`、`Tavily search request failed: <error>`、`Tavily returned an unprocessable response body: <error>` 等失败原文。

#### KV 缓存影响

无直接失效；请求前缀的变化由具名消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义了本提供方何时是糟糕选择。它们是当前的包约束。

- **没有 URL 的结果被整体丢弃** — 没有可引用地址，因此返回的来源可能少于请求数量。
- **发送给 Tavily 的结果数钳制在 20** — Tavily 拒绝更高的 `max_results` 值；服务仍会在响应上执行调用方的更大界。
- **仅暴露 `searchDepth`/`includeAnswer`/`numResults`** — Tavily 的其他控制（域名过滤、时间范围、原始内容）等待提供方中立的服务字段（[接缝 Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **中止分类基于错误形状** — 只有名为 `AbortError` 的 `DOMException` 映射为 `WEB_ABORTED`；携带自定义原因的中止（如 `dsh-timeout` 的 `TimeoutReason`）以 `WEB_PROVIDER_ERROR` 呈现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

本开发备注是维护者的工作背景：开放问题与未定方向。它明确地不具权威性——已交付的行为、限制与依据以上文及链接的 Agent Note 为准。

#### 未来：更宽的 Tavily 控制面

Tavily 的域名过滤、时间范围与原始内容检索暂不暴露。暴露它们需要先有提供方中立的服务字段，因此本家族会以一次协调的变更增加一个控制项，而不是某个厂商特有的参数。

</details>
