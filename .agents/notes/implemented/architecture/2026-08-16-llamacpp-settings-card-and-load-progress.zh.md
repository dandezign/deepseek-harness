# Agent Note: llama.cpp 设置卡片、可选凭据与转发事件通道上的加载进度

Status: implemented

[English](2026-08-16-llamacpp-settings-card-and-load-progress.md) | 中文

> 范围：`llamacpp` provider 如何成为 Models 页的一等公民，其可选凭据为何是目录字段而非 UI 特例，以及模型加载进度为何走 `llm/model-load-progress` 而不是会话事件或 mux 帧。

## 问题

首次用 web UI 驱动真实 llama.cpp 路由器时，三个故障一起浮现。(1) Models 页把 `llm-llamacpp` settings 命名空间渲染成 `unknown` 布局——一行提示加永久禁用的保存按钮——导致该 provider 完全无法从 UI 配置；用户退回到通用 `llm-pi-ai` 路由，它能分类 `MODEL_NOT_LOADED` 却无法加载任何模型，原始的 `400 "model is not loaded"` 直接到达回合。(2) 路由器探测 `GET /props` 未携带 bearer 令牌，加 `--api-key` 启动的服务器回答 401，生命周期自行停用，同一个 400 在专用适配器上也会浮现。(3) 一次耗时数分钟的加载完全发生在宿主适配器内部，没有任何东西告诉用户模型切换正在推进。

## 决策

**设置卡片是一种适配器族布局，可选凭据是适配器声明的目录字段。** `ProviderEditor` 在 `deepseek` 与 `pi-ai` 旁新增 `llamacpp` 族（端点、带可选密钥占位的密钥输入，以及共享的 `ModelListEditor`——其 fetch 动作既是保存前的连接测试，也是候选选择器）。`LlmConfigurableProvider.credentialOptional`（经 `llm.providers` 投影为 `ConfigurableProviderView.credentialOptional`）陈述只有适配器知道的事实：该路由无需存储凭据即可服务请求。`providerUsable` 与缺钥圆点读取该字段，而不是让 UI 硬编码 provider id——与 `declared` 相同的"只有适配器能回答"推理。

**加载进度是转发事件通道上的单向类型化 Host 事件。** `llm/model-load-progress`（`{provider, model, phase: 'loading' | 'ready' | 'failed', message?}`）由生命周期在每个转移的提交点发出——加载发起或加入时，以及落定时——对已常驻的模型绝不发出。它是传输状态而非模型输入，因此不是会话事件（model-visible ⟺ logged），也不是 `MuxFrame` 变体（会话级整快照状态带重连基线）；它是 `API_REMOTE_FORWARDED_EVENTS` 中的一个条目，既有 shape gate 将其约束为真实、非 scope、单向事件。`ui-model-selection` 的服务经 `ctx.remote.$on` 订阅并持有一个 `SnapshotStore`，composer 模型席位将其渲染为加载/切换横幅；终态在保持一段时间后自行清除，除非更新的加载取代了它。重连间隙会丢失在途帧——对瞬态横幅可接受，通过终态事件与 `llm/adapters-updated` 收敛。

## 后果

- `/props` 携带解析出的 bearer 令牌：启用鉴权的路由器保住其生命周期，这正是让加载重试路径（与弹窗）在最需要它的服务器上生效的前提。
- web 设置页无需新的 wire 方法：fetch 动作询问的正是草稿显示的端点，"保存前测试连接"与"列出模型以采纳"是同一次往返。
- 确实需要密钥的 provider 不受影响：`credentialOptional` 缺席在所有地方都意味着旧语义。

## 考虑过的替代方案

**以 `llamacpp` provider id 为键的 UI 侧特判。** 在 `providerUsable` 与密钥字段里点名 provider id 会把 client 包耦合到某一个适配器的身份，并复刻只有适配器才知道的事实；`credentialOptional` 把事实放回目录已在投影适配器知识的位置（`declared` 使用同一推理）。

**把加载进度做成 session 事件或 `MuxFrame` 变体。** session 事件会让传输状态可重建为模型输入（违背 model-visible ⟺ logged 契约），而 mux 帧会给一个瞬态横幅配上它并不需要的会话级整快照语义；转发事件通道正是为这种单向 host→client 通知而存在的。

**随仓库发布映射到最近可接受值的 `high`/`max` 思考档位。** 渲染模板证明 Qwen3.8 对 low/medium/xhigh 之外的任何值都报服务器错误，而 Qwen3.6/Qwen2.5 完全忽略该旋钮——钳制或别名要么在真实服务器上 500，要么静默发送模板从不读取的值。精确声明经验证的词汇并在客户端拒绝其余（`INVALID_REQUEST`）让失败点名自己的解法。

## 真实部署撞上的路由冲突

首个真实部署在新增小节的同时保留了手工声明的 `llm-pi-ai.providers.llamacpp` 小节。pi-ai 先注册了路由，专用插件的 `registerAdapter` 于是在其 settings 变更回调里抛出 `DUPLICATE_ADAPTER`——被包含、日志泛化、UI 里不可见，而每次聊天继续打到 pi-ai 适配器并以 `MODEL_NOT_LOADED` 失败（pi-ai 能分类该措辞却无法加载任何模型）。修复保持一路由一适配器的设计，并让失败点名自己的解法：插件以"从 llm-pi-ai settings 小节移除重复条目"重新抛出，README 的迁移说明同义。该部署自身的 settings 已迁移：把精选模型列表移入 `llm-llamacpp:`（迁移丢弃了 pi-ai 路由的图像输入；专用适配器 v1 为纯文本）。

## 思考控制：模板自身的词汇，经渲染验证

llama.cpp 聊天模板掌握思考控制，且模板之间互不一致。词汇不是猜测，而是在真实路由器构建 `b10443-27df9199d` 上通过 `POST /apply-template`（零 token 生成）渲染各系别模板确立的：Qwen3.8-27B 映射分级 `reasoning_effort`——low / medium / xhigh，xhigh 为模板默认——且对任何其他值（包括 `high` 与 `max`）抛出 Jinja 服务器错误；Qwen3.6-12B 完全忽略 `reasoning_effort`；Qwen2.5 两个变量都忽略。所有测试过的系别都支持 `enable_thinking: false` 表示关闭。因此适配器恰好声明 `low / medium / xhigh / off`：分级级别走 `chat_template_kwargs.reasoning_effort`（未读取处无害忽略），`off` 走 `enable_thinking`，不支持的值在客户端以 `INVALID_REQUEST` 拒绝而不是招来提供方 500，且**没有适配器默认**——未选择的会话不发送 kwargs，由模板自身的默认值决定。被要求的 `high`/`max` 词汇基于此证据被婉拒：模型会在每个请求上拒绝两者。
