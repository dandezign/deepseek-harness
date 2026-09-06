# Agent Note: Tavily 与 Firecrawl 搜索提供方加入 web 接缝

Status: implemented

[English](2026-09-06-web-search-tavily-firecrawl-providers.md) | 中文

## 问题

web 接缝已交付五个搜索后端（Exa、Perplexity、DeepSeek、Scrapling 之上的 DuckDuckGo），但没有厂商账号的部署选择仍然有限：DuckDuckGo HTML 抓取是唯一的无密钥路径，也是最容易遭遇 IP 封锁的一条。Tavily 提供无需信用卡的循环免费额度，Firecrawl 上线了按速率而非密钥计量的无密钥搜索模式；harness 此前无法触达两者。

## 决策

两个新的搜索提供方按既有插件形态注册进 `ctx.web`，各自像 `web-scrapling` 一样由部署补丁挂载：

- `web-search-tavily`（`tavily`）：需要 API 密钥（环境回退 `$TAVILY_API_KEY`），把发出的 `max_results` 钳制到 Tavily 文档中的 API 上限 20，而接缝仍按调用方的原始界执行；把 Tavily 的 `content` 映射为 `snippet`，并在 `includeAnswer` 开启时把生成答案作为 `content` 携带——与 Perplexity 答案的待遇相同。
- `web-search-firecrawl`（`firecrawl`）：无密钥是一等模式——空密钥完全省略 `Authorization` 头，可用性只取决于端点本身——且一个映射器同时接受 v1 的扁平 `data` 数组与 v2 的 `data.web` 信封，使自托管或旧版本端点持续可用。

两个提供方都在联系 `Location` 目标之前拒绝重定向，并有真实 HTTP 服务器的覆盖证明该目标永不被触达（packages/web/AGENTS.md 凭据规则）；演示用例使用自定义凭据头，因为 fetch 规范会在跨源重定向时剥离 `authorization`——这正是该策略要堵住的洞。

## 已考虑的替代方案

**把新提供方挂进随附的基础包。** 否决：基础包已固定 `searchProvider: deepseek-official`，而一个始终可用的无密钥提供方与其他提供方同时挂载，会把 `WEB_PROVIDER_AMBIGUOUS` 扩大到每个清除了固定项的部署。非默认提供方经由补丁按需挂载，遵循 `web-scrapling` 与 `web-search-exa` 的先例。

**像 Tavily 一样钳制 Firecrawl 的 limit。** 否决：Tavily 超过 20 会报错而 Firecrawl 接受更高值；此处钳制会在没有服务端理由的情况下悄悄收窄调用方的合法界限。

## 验证

每个包都带有 mock fetch 规格（映射、可用性、请求形状、中止/HTTP 错误分类、HMR 安全地注册进 `ctx.web`）、真实 HTTP 服务器的重定向规格，以及环境门控的实况 e2e；Firecrawl 的 e2e 以无密钥方式实跑通过。`pnpm run typecheck`、`pnpm run build` 与三个包的测试套件全部通过。

## 后果

部署在 IP 脆弱的 DuckDuckGo 抓取器之外，获得一条无需信用卡的免费档搜索路径（Tavily）与一条零配置的无密钥路径（Firecrawl）。提供方家族增加两个插件而接缝不变；更宽的控制面（域名过滤、时间范围）仍按接缝记录等待提供方中立的服务字段。
