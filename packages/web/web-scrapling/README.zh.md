# @deepseek-ai/dsh-web-scrapling

[English](README.md) | 中文

面向 `ctx.web` 能力缝的无密钥 Web 提供方：一个抓取 DuckDuckGo HTML 端点的**搜索提供方**（`id: duckduckgo`），和一个以 Chrome TLS 指纹获取页面并抽取正文的 **Scrapling 抓取提供方**（`id: scrapling`）。二者都在托管 Python 虚拟环境中运行 [Scrapling](https://github.com/D4Vinci/Scrapling)——无需任何搜索 API 密钥。

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-web` | Service Definition：`ctx.web`、提供方注册表、选择策略 |
| `@deepseek-ai/dsh-web-scrapling`（本包） | 搜索提供方（DuckDuckGo）+ 抓取提供方（Scrapling），共享一个托管 venv |
| `@deepseek-ai/dsh-tool-web` | Consumer：面向模型的 `web_search` / `web_fetch` 工具 |

## 提供方

搜索提供方把每条解析出的 DuckDuckGo 结果映射为 `WebSearchSource`（`url` 必需；空标题/摘要省略；无 URL 的条目丢弃），从不产出 `content` 与 `publishedAt`，并返回 `truncated: false`——`maxResults` 截断由能力缝统一执行。请求不携带任何凭证。

抓取提供方先把目标校验为绝对 http(s) URL（否则 `WEB_INVALID_URL`），再按配置的模式获取：

| 模式 | 获取方式 |
|---|---|
| `standard`（默认） | 普通 HTTP + 隐蔽请求头与 Chrome TLS 指纹，30 秒请求超时 |
| `stealth` | 无头隐身浏览器（可选 Cloudflare 挑战求解），拦截广告与资源 |
| `dynamic` | 完整无头浏览器自动化并渲染 JS（可选 `networkIdle`、`waitSelector`） |

抽取恒定产出 `WebFetchBody` 的 `kind: "text"`：优先 trafilatura 正文，回退 markdownify。非 2xx 页面是一个结果（Python 工具上报页面状态）而非抛错。stealth/dynamic 模式会在安装阶段下载浏览器引擎（`playwright install chromium`）。

## 托管 Python 环境

两个提供方共享一个管理 `venvRoot`（默认 `$DSH_HOME/web-scrapling`）下 venv 的运行时：

- `autoSetup: true`（默认）：首次使用时定位 Python 3.10+ 解释器（`pythonCommand` 覆盖平台候选：Windows 为 `python`/`py -3`，其他为 `python3`/`python`），创建 venv、安装 `scrapling[fetchers]`（抓取模式需要时另装浏览器引擎）并写入完成标记。并发的首次调用共享一次安装；失败的安装由下一次调用重试。
- `autoSetup: false`：venv 必须已存在，否则首次操作即带精确命令行响亮失败（`WEB_PROVIDER_UNAVAILABLE`）。
- 环境损坏（工具退出码 3 或上报导入失败）会重跑一次安装修复，然后重试该操作。

取消与超时会杀死子进程（`WEB_ABORTED`，或提供方自有超时码 `SCRAPLING_SEARCH_TIMEOUT` / `SCRAPLING_FETCH_TIMEOUT`）。工具交互为 argv 上的一个 JSON 请求与 stdout 上的一个 JSON 结果，上限 64 MiB。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `pythonCommand` | 平台候选 | 用于创建 venv 的基础 Python 3.10+ 解释器 |
| `venvRoot` | `$DSH_HOME/web-scrapling` | 托管 venv 目录 |
| `autoSetup` | `true` | 首次使用时创建并安装 venv |
| `fetchMode` | `standard` | `standard` / `stealth` / `dynamic` 获取模式 |
| `solveCloudflare` | `false` | stealth 模式：尝试求解 Cloudflare 挑战 |
| `networkIdle` | `false` | dynamic 模式：等待网络空闲 |
| `maxBodyChars` | `50000` | 每次抓取返回的最大抽取字符数 |
| `searchTimeoutMs` | `120000` | 单次搜索交互的截止时间 |
| `fetchTimeoutMs` | `180000` | 单次抓取交互的截止时间 |
| `setupTimeoutMs` | `600000` | 一次性安装流水线的总时限 |

选择策略：未配置 id 时，只要本包是唯一**可用**提供方即自动选中——已注册但缺密钥的 `deepseek-official` 搜索提供方不算可用，因此单独挂载本包即可。若同时挂载了另一个可用抓取提供方（例如 `web-fetch-http`），需在能力缝上显式配置 `fetchProvider`，否则能力缝抛出 `WEB_PROVIDER_AMBIGUOUS`。

## Model Experience

间接生效：`@deepseek-ai/dsh-tool-web` 拥有 `web_search` / `web_fetch` 的工具 schema、提示词指引与结果呈现；本包只贡献归一化后的提供方数据或抛出的 `WebError` 错误码。

#### KV Cache effect

无直接失效；命名 Consumer 拥有任何请求前缀变化。

## Known Limitations and Deferred Work

- **无 SSRF 防护**——scrapling 抓取器可触达模型指名的任意 http(s) 目标，包括浏览器可达的内网；stealth/dynamic 模式还附带完整浏览器引擎。不要在可触达敏感内网目标的环境中启用。
- **DuckDuckGo HTML 端点并非 API**——结果解析依赖端点稳定的 HTML 结构；HTTP 200 但无可解析结果的页面会退化为空结果，而非 200 的异常或限流响应会以 `WEB_PROVIDER_ERROR` 醒目报错，不会被误读为空结果。
- **按请求的抓取控制是提供方配置而非工具参数**——能力缝的 `WebFetchRequest` 仅有 `{url}`；`cssSelector` 一类的抽取范围控制推迟到能力缝长出提供方中立的抓取控制后再做（[能力缝设计](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **StealthyFetcher 自带的浏览器在首次 stealth 调用时由 Scrapling 下载**——安装阶段只为 dynamic 模式安装 Playwright Chromium 引擎；stealth 模式的 Camoufox 引擎在其首次调用时下载，且不计入 `setupTimeoutMs`。
