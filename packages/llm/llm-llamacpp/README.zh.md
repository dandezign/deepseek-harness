---
description: "面向 harness LLM seam 的 llama.cpp 适配器：OpenAI 兼容对话，外加多模型路由所需的确保加载生命周期、发现与设置卡片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-llamacpp

[English](README.md) | 中文

## 概述

面向 harness LLM seam 的 llama.cpp 适配器：经由服务器 OpenAI 兼容端点对话，并补上多模型路由所需的模型生命周期——请求前确保已加载、针对路由器"model is not loaded"竞态的一次加载重试、可选的切换后卸载，以及能从在线列表读出上下文窗口与视觉能力的模型发现。单个插件实例拥有唯一的 `llamacpp` provider 路由，并在 settings 提供 `baseURL` 之前以**休眠**方式挂载。

对话 wire（SSE 分帧、chunk 翻译、用量映射、消息序列化）与 [`dsh-llm-deepseek`](../llm-deepseek/README.zh.md) 共享；本包拥有的是一切 llama.cpp 特有之物。

## 目录

- [Config](#config)
- [模型生命周期](#model-lifecycle)
- [发现](#discovery)
- [错误](#errors)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

## Config

```yaml
- id: llm-llamacpp
  name: '@deepseek-ai/dsh-llm-llamacpp'
  config:
    baseURL: http://192.168.0.92:8080   # server origin; a trailing /v1 is tolerated and stripped
    # apiKeyEnv: LLAMACPP_API_KEY       # optional: omit entirely for a server without --api-key
    # autoLoad: true                    # ensure-loaded before each request (default)
    # autoUnload: on-switch             # never (default) | on-switch
    # loadTimeoutMs: 600000             # cold GGUF loads take minutes
    # pollIntervalMs: 1000              # listing safety net; /models/sse drives transitions
    # watchEvents: true                 # watch /models/sse instead of polling at full rate
    # defaultContextWindow: 32768
    # maxTokens: 8192
    # models: []                        # Fetch available models proposes entries with capacities
    # A second box is another entry here, not another composition row.
    # providers:
    #   workstation:
    #     baseURL: http://192.168.0.40:8080
    #     displayName: Workstation
```

`baseURL` 是服务器 **origin**，而非 OpenAI 兼容前缀：控制面（`/props`、`/models/load`、`/models/unload`）与 `/v1` 并列而非位于其下。粘贴 `http://host:8080/v1` 会被规范化而非拒绝。缺省时回退到受信环境层的 `$LLAMACPP_BASE_URL`；没有任何端点时插件休眠挂载——零路由、Models 页卡片仍会出现——并在 `llm-llamacpp:` settings 小节提供端点的那一刻起开始服务。

凭据是**可选的**：未加 `--api-key` 启动的 llama.cpp 服务器接受匿名请求，因此无法解析的引用退化为不发送 `Authorization` 头，而不是让每个请求都失败（与托管 provider 适配器相反，那里 `MISSING_CREDENTIAL` 才是正确答案）。确实启用密钥的服务器会以 `AUTH` 拒绝匿名请求。目录条目声明了 `credentialOptional`，因此 Models 页把无密钥的存活路由视为可用，且绝不给它标"API 密钥缺失"。

<a id="model-lifecycle"></a>
## 模型生命周期

基于 llama.cpp 构建 `b10443-27df9199d` 的实测行为；适配器在每个配置生成内探测一次 `GET /props`（能解析出密钥时携带 bearer 令牌——加 `--api-key` 启动的服务器对匿名探测回答 401），凡非 `role: "router"` 即退化为无操作生命周期，因此普通单模型服务器行为与从前完全一致。

**[Strata](https://github.com/Niko1221/Strata) 服务器同样纳入管理。**它的 `/props` 不带 `role`，适配器以 `models_autoload` 标记识别（`build_info: "Strata …"` 佐证），转而驱动整台服务器的 `POST /load` / `POST /unload`，而非路由器的按模型调用；`/load` 回答 `409` 表示已有请求在运行，模型必然已常驻，等待随之继续。常驻状态读自 `/v1/models` 列表——非常驻的 Strata 以空数组作答，因此列表中缺失的模型读作 `unloaded` 而非未知；发现则回退到 `/props`，其 `model_alias` 即便在休眠时也给出所服务模型的上下文窗口与视觉能力。`/models/sse` 流不被使用：轮询足以覆盖状态转移。

- **每次请求之前**（`autoLoad`，默认开启）：从 `/v1/models` 读取模型实时状态；`loaded` 立即放行，其余状态 POST `/models/load` 并轮询直至就绪，以 `loadTimeoutMs` 为上界。对同一模型的并发请求共享单个进行中的等待；等待途中回落到 `unloaded` 的模型恰好获得一次重新加载。
- **not-loaded 竞态**：其他客户端可能在预检与 chat POST 之间卸载模型，路由器以 `400 {"message":"model is not loaded"}` 作答——由 `dsh-llm` 的共享分类器归入 `MODEL_NOT_LOADED`。适配器恢复一次——重新确保、重试请求——然后才浮现错误。
- **切换**：在 `max_instances: 1` 下加载模型 B 会由路由器自行驱逐 A，因此在选择器里切换模型即可工作；切换后的第一个请求承担加载耗时。`autoUnload: on-switch` 额外在没有进行中请求持有先前常驻模型时（按模型引用计数）将其卸载——对路由器不做驱逐的多实例服务器是清理手段。
- **进度**：每次加载转移在其提交点上以 Host 事件 `llm/model-load-progress`（`{provider, model, phase: 'loading' | 'ready' | 'failed', message?}`）发出——加载发起或加入时，以及落定时。进度是传输状态：绝不进入模型输入、绝不写入会话日志；web 会话界面将其渲染为加载/切换横幅。已常驻的模型不发出任何事件。
- **思考控制**：模型暴露其聊天模板真正读取的词汇，通过 `/apply-template` 渲染各模板验证（构建 `b10443-27df9199d`）：Qwen3.8 系映射分级 `reasoning_effort`——**low / medium / xhigh**，xhigh 为模板默认——且对任何其他值（包括 high 与 max）抛出服务器错误；Qwen3.6 与 Qwen2.5 时代模板完全忽略 `reasoning_effort`。**Off** 走 `enable_thinking: false`，所有测试过的系别都支持。没有默认级别：未选择的会话不发送 kwargs，由模板自身的默认值决定（Qwen3.8 为 xhigh，Qwen3.6 为普通思考）。
- **范围**：适配器只经 wire 管理模型。它绝不启动、重启或监管 `llama-server` 本身，也不改动服务器的 `models_autoload` 设置——那仍是部署侧替代 `autoLoad` 的一行方案。

<a id="discovery"></a>
## 发现

配置卡上的 "Fetch available models" 经 `ctx.llm.registerModelDiscovery('llm-llamacpp', …)` 询问 `GET /v1/models`。路由器列表披露的远多于 OpenAI 兼容最小集，读取器将其呈现：

- `status.args` → `--ctx-size` → 模型的**上下文窗口**（通用读取器留给手工设置的数字）；
- `architecture.input_modalities` → 视觉/纯文本元数据；
- 实时 `status.value` → 当前哪个模型常驻。

发现不存储任何东西；采纳候选只更新草稿，`settings.yaml` 仍是唯一的目录权威。既未配置也未标注容量的模型回退到 `defaultContextWindow`（32,768——llama.cpp 自身默认）与 `maxTokens`（8,192）。

<a id="errors"></a>
## 错误

非 2xx 的 chat 响应以与 DeepSeek 适配器相同的 `httpErrorCode` 映射抛出 `LlmError`：`AUTH`（401/403）、`QUOTA`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、**`MODEL_NOT_LOADED`**（已知但未加载的模型）、`INVALID_REQUEST`（其余 400）、`SERVER`（5xx）、其余为 `HTTP_<status>`。超过 `loadTimeoutMs` 的加载等待抛 `TIMEOUT`；传输失败点名端点并链接原因。每个请求携带 dsh-llm `attributionHeaders()` 的共享归因头。

流中途的失败以一个终止性的 `data: {"error": …}` 载荷到达，随后流在无 `[DONE]` 的情况下关闭——常见成因是 decode 期间的 Vulkan 设备丢失。适配器会以相同的映射（通常为 `SERVER`）浮现该载荷自身的消息，使回合错误点名的失败本身，而非帧错误。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

适配器的设置卡片、加载进度事件与生命周期决策由 [llama.cpp 设置卡片 note](../../../.agents/notes/implemented/architecture/2026-08-16-llamacpp-settings-card-and-load-progress.zh.md)持有；共享的 chat wire 以 `dsh-llm-deepseek` 构建后的 `./wire` 子路径发布，使纯 Node 的 profile 启动与 tsx 源码启动解析一致。

</details>


## Model Experience

### llama.cpp 请求

#### 模型所见

所选模型接收序列化到共享 chat-completions wire 上的 `GenerateOptions.system`、历史、工具与采样字段。本适配器不添加任何提示词。`reasoningEffort` 映射到 `chat_template_kwargs`——`low`/`medium`/`xhigh` 映射到 `reasoning_effort`，`off` 映射到 `enable_thinking: false`；缺省时不发送 kwargs，由聊天模板自身的默认值决定。

#### Token 效应

提供方分词决定确切输入；转换不添加模型可见文本。`cacheReadTokens` 映射自 llama.cpp 原生报告的 `prompt_tokens_details.cached_tokens`。

#### KV Cache 效应

转换保持逻辑请求顺序、不添加文本；llama.cpp 自身的前缀缓存决定复用。会话中途切换模型改变请求目标，并从第一个不同 token 起破坏复用，与在任何提供方上切换模型一致。

### llama.cpp 响应

#### 模型所见

`reasoning_content` 增量（思考模板）成为 harness reasoning 块；`content` 成为文本；工具调用增量按 wire 索引拼接；`finish_reason` 与用量延迟到 `[DONE]`，与 DeepSeek wire 一致。

#### Token 效应

生成内容仅在循环记录之后影响后续输入。`completion_tokens_details` 报告推理 token 时予以映射。

#### KV Cache 效应

已记录的响应内容追加到下一个请求，不使其更早的可复用前缀失效。传输元数据与用量核算不影响缓存身份。

## Known Limitations and Deferred Work

- **视觉需要投影器与声明两者** —— 图像序列化为 OpenAI 风格的 `image_url` content parts，而只有以匹配的 `--mmproj` 启动的服务器才能读取它们。适配器无法探测这一点，因此模型在目录条目中携带 `inputModalities: [text, image]`（"Fetch available models" 会从在线列表提议它），而宿主对没有它的每个模型都在附加前拒绝图像。
- **`/models/sse` 连接断开会丢失在途转移** —— 观察者会重连，列表安全网也会收敛状态，因此等待仍会落定；断开损失的是及时性而非正确性。观察者绝不会成为依赖：设 `watchEvents: false`，或运行一个对该流返回 404 的构建，生命周期便与从前完全一样地轮询。
- **具名路由自行声明端点** —— `$LLAMACPP_BASE_URL` 只指代一台服务器，因此它仅填充默认的 `llamacpp` 路由；没有自己 `baseURL` 的 `providers` 条目保持休眠，而不是悄悄指向同一台机器。同时在顶层与 `providers.llamacpp` 声明端点会被拒绝，因为二者对默认路由指向哪台服务器的说法不一致。
- **名为 `llamacpp` 的 pi-ai 路由会冲突** —— `DUPLICATE_ADAPTER`，这是设计使然：采用本适配器时把路由移出 `llm-pi-ai:` 小节，因为生命周期管理正是你迁移它的原因。注册失败会在宿主日志中点名这次移除。
- **思考级别是模板自身的，不是通用刻度** —— 只有 Qwen3.8 系读取 `reasoning_effort`（low/medium/xhigh；high 与 max 被以服务器错误拒绝，因此适配器在客户端即拒绝）。wire 上没有任何东西告知模型用的是哪个模板，因此读取更少级别的模型在目录条目中固定它们：在 Qwen3.6 时代模型上写 `reasoningEfforts: [off]`，可阻止选择器提供那些形同虚设的分级选项。缺省仍提供完整词汇。
- **控制调用与 chat 共用超时词汇** —— `loadTimeoutMs` 覆盖一整次加载；没有单独的按 POST 控制超时。

本包不发布运行时不变量伴生件：适配器不拥有事件序列或持久可变关系；生命周期与列表状态存在于 `llm` 注册表自有结构中，由该注册表自己的伴生件断言。
