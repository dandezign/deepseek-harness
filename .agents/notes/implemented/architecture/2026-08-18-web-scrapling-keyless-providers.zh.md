# Agent Note：托管 Python 环境上的无密钥 Scrapling Web 提供方

Status: implemented

[English](2026-08-18-web-scrapling-keyless-providers.md) | 中文

## Problem

所有随仓库发布的 web 搜索提供方都需要 API 密钥（`web-search-deepseek` 复用 `DEEPSEEK_API_KEY`，Exa 与 Perplexity 各自持有）。模型提供方为本地或第三方（llama.cpp、pi-ai 路由）的部署因此可以挂载随仓库发布的 `tool-web`，`web_search` 却仍以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败——工具存在，能力无法运行。用户已验证的答案是 Scrapling 技术栈（以 Chrome TLS 指纹抓取 DuckDuckGo HTML 搜索，外加反爬与 JS 渲染抓取），不需要密钥，但需要一个安装了 `scrapling[fetchers]` 的 Python 运行时。

由此产生两个设计问题。其一，无密钥抓取是具有安全影响（浏览器引擎抓取模型指名的 URL）的部署选择，必须是显式选入的挂载，绝不能进入随仓库发布的默认组合。其二，harness 没有供宿主插件使用的托管 Python 运行时：Python SDK 把 dsh 作为子进程驱动，并不为宿主插件提供解释器。venv 生命周期——创建、安装、修复、并发首调共享——需要在提供方包内有一个唯一属主。

## Decision

`@deepseek-ai/dsh-web-scrapling` 向既有 `ctx.web` 能力缝注册两个提供方，不改变任何面向模型的表面：`duckduckgo`（搜索）与 `scrapling`（抓取）。`dsh-tool-web` 继续拥有 `web_search`/`web_fetch` 的 schema，[web 能力缝 note](2026-06-24-web-capability-seam.md) 的稳定性契约因此得以保持——换入无密钥提供方对模型契约不可见。

两个提供方共享同一个 `ScraplingRuntime`，由它拥有托管 Python 环境：

- 安排在首次操作时执行（最早可解析点；安装并非加载期自足，因为它需要网络），由一个 in-flight promise 守护，使并发的首次调用共享一次安装；失败的安装会重置该 promise，由下一次调用重试。
- 完成态是标记文件加 venv 解释器存在；除非 `autoSetup: true` 让提供方为能力缝选择保持乐观（`available()` 返回 true），否则它就是廉价的标记探测——这让"唯一可用提供方自动选中"在已注册但缺密钥的 `deepseek-official` 旁边仍然成立。
- 工具退出码 3 或带 `environment: true` 的结果表示环境（而非该操作）损坏：运行时重跑一次安装修复并重试该操作一次。其余一律是领域性 `WEB_PROVIDER_ERROR`、`WEB_ABORTED` 或提供方自有超时码。
- 工具契约是 argv 上的一个 JSON 请求与 stdout 上的一个 JSON 结果（camelCase 键；TypeScript 请求类型即唯一契约），上限 64 MiB，从包 lib 旁解析的 `scripts/scrapling_tools.py` 执行，源码与构建启动共用同一文件。

抓取模式控制（`fetchMode`、`solveCloudflare`、`networkIdle`、`maxBodyChars`）是提供方配置而非工具参数：能力缝的 `WebFetchRequest` 刻意只有 `{url}`，因此 stealth/dynamic 获取与抽取范围是部署选择。`web-fetch-http` 的诚实限度先例在此适用：无 SSRF 防护，README 明示，因为抓取浏览器能触达的就是浏览器能触达的。

挂载点是 `$DSH_HOME/cordis.patch.yml` 用户层（或任意 `--patch` 覆盖）：一条 `insert` 行。搜索无需更多——standard preset 的 `tool-web` 行已注册 `web_search`。启用 `web_fetch` 还需要一份用户 preset，其 `tool-web` 行设 `fetch: true`，因为随仓库发布的 preset 因 fetch 的 SSRF 立场未定而默认关闭它。

## Package topology

- `packages/web/web-scrapling/src/runtime.ts` —— venv 生命周期、子进程交互、中止/超时/溢出守护、修复一次。
- `packages/web/web-scrapling/src/provider.ts` —— `DuckDuckGoSearchProvider`、`ScraplingFetchProvider`、结果映射。
- `packages/web/web-scrapling/scripts/scrapling_tools.py` —— JSON-over-argv 的 Scrapling 工具（搜索 + 三种抓取模式）。
- 测试通过 node fixture 解释器覆盖交互分类器（无需 Python）、通过模拟子进程交互覆盖安装流水线、通过真实能力缝覆盖 HMR 卸载；`DSH_SCRAPLING_E2E` 门控的 e2e 验证真实 venv 流水线与线上查询。

## Alternatives considered

**纯 TypeScript 的 DuckDuckGo 抓取器，不依赖 Python。** Node 的 `fetch` 呈现非浏览器 TLS 指纹，DuckDuckGo HTML 端点对其质询日益频繁，且反爬/JS 渲染抓取在 Node 侧没有对等物；Scrapling 技栈经过了日常使用验证。保留子进程也让所有模式共用同一获取实现，而非让 TS 复刻与 Python 实现逐渐漂移。

**原样复用既有 opencode 插件的惰性自动安装。** 在 `execute` 内按需安装并缓存失败状态会掩盖错误配置，也没有中止/超时/生命周期契约。托管运行时保持 dsh 惯例：安装发生在最早可解析点，并发首调共享，错误带精确修复命令响亮失败，并以"修复一次再重试一次"取代静默降级。

**每个提供方一个包（照搬 `web-search-exa`）。** 两个提供方共享 venv、解释器发现、标记与修复状态；拆分要么在两个包里重复环境生命周期，要么为两个文件引入第三个环境属主包。一个包向能力缝的两个注册表各注册一个提供方不违反任何规则，也让共享生命周期只有唯一属主。

**扩展能力缝的抓取请求以承载模式/选择器控制。** `WebFetchRequest` 刻意只有 `{url}`；按请求的抓取控制会把提供方词汇泄漏进每个 Consumer 与模型契约。提供方上的部署级配置保持了能力缝的提供方中立性，代价是切换模式需要一次 venv 重启。

## Consequences

对没有搜索 API 密钥的部署而言，无密钥 web 搜索与反爬抓取现在只差一行显式挂载，且模型侧工具契约毫无变化——但代价是 Python 3.10+ 依赖、首次使用的安装延迟（pip install，stealth/dynamic 抓取还有浏览器引擎下载），以及 README 中如实记载而非悄悄收窄的 SSRF 缺口。DuckDuckGo HTML 解析可能随页面改版退化为空结果，对非 API 端点的高频自动化使用也带有 harness 无法消除的限流风险。挂载不进入随仓库发布的默认组合，因此安全触达始终是显式的部署选择。
