# Agent Note：llama.cpp 流中途错误载荷以服务器错误呈现

Status: implemented

[English](2026-09-02-llamacpp-stream-error-payload-fails-loud.md) | 中文

## 问题

llama.cpp 报告流中途失败的方式与本 harness 使用的其他 wire 都不同：它不发 HTTP 状态码，而是发出一个终止性的 `data: {"error": {"code", "message", "type"}}` 载荷，然后在无 `[DONE]` 的情况下关闭流。共享 SSE 契约把 `[DONE]` 之前的 EOF 视为截断，因此一台死掉的推理设备（常见情形：`decode() failed: vk::Device::waitSemaphores: ErrorDeviceLost`——decode 途中 Vulkan 设备丢失）呈现为含混的 `STREAM_CLOSED`"SSE stream ended without [DONE]"，只点名传输层，把 GPU 故障完全藏了起来。

## 决策

llama.cpp 适配器在共享翻译之前包裹解析出的 SSE 载荷流，并检查每个载荷是否为终止性错误形态。携带 `error` 的载荷会抛出 `LlmError`，消息为服务器自己的消息、并经共享的 `httpErrorCode` 映射——通常为 `SERVER`，当消息指名未加载模型时为 `MODEL_NOT_LOADED`——因此回合错误携带诊断。其余一切，包括 `[DONE]` 与非 JSON 载荷，原样通过；共享的 `DONE` 哨兵现从 wire 子路径导出以供该比较使用。

## 已考虑的替代方案

**为 llama.cpp 放宽共享的 `[DONE]` 帧约束。** 否决：真正被截断的生成不是完整的回答，帧错误是对它的正确报告；只有服务器自身的错误载荷应优先于它。

**在共享翻译器内处理该错误形态。** 否决：DeepSeek 从不发送流中途错误载荷，这一检查会停留在一条不可能产生该输入的 wire 上；该形态是 llama.cpp 的行为，属于 llama.cpp 适配器。

**像 pi-ai 那样把载荷映射为 `finish_reason` 风格的停止原因。** 否决：harness 的流词汇把失败表达为带机器可路由代码的抛出 `LlmError`，与其他所有经过相同重试与 UI 分类的失败路径一致。

## 验证

mock 路由器流出与现网完全一致的形态——一个 `{"error": …}` 载荷，随后无 `[DONE]` 关闭——适配器 spec 断言抛出的消息是服务器自己的消息（`decode() failed: …ErrorDeviceLost`）、代码为 `SERVER`；包测试套件照旧覆盖正常流、not-loaded 竞态与恢复路径。

## 后果

崩溃的推理设备如今表现为它自身的失败（`decode() failed: …ErrorDeviceLost`，代码 `SERVER`），而不是传输帧错误，运维者因此被指向 GPU 而非网络。逐载荷的 JSON 探测仅为该路由上的每个分块增加一次解析；共享的 DeepSeek wire 不受影响。
