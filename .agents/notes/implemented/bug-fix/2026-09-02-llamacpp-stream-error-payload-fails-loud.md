# Agent Note: llama.cpp mid-stream error payloads surface as server errors

Status: implemented

English | [中文](2026-09-02-llamacpp-stream-error-payload-fails-loud.zh.md)

## Problem

llama.cpp reports mid-stream failures differently from every other wire the harness speaks: instead of an HTTP status, the server emits one terminal `data: {"error": {"code", "message", "type"}}` payload and closes the stream without `[DONE]`. The shared SSE contract reads EOF before `[DONE]` as truncation, so a dead inference device (the common case: `decode() failed: vk::Device::waitSemaphores: ErrorDeviceLost` — a Vulkan device loss mid-decode) surfaced as the opaque `STREAM_CLOSED` "SSE stream ended without [DONE]", naming the transport and hiding the GPU failure entirely.

## Decision

The llama.cpp adapter wraps the parsed SSE payload stream before the shared translation and inspects each payload for the terminal error shape. A payload carrying `error` throws `LlmError` with the server's own message through the shared `httpErrorCode` mapping — typically `SERVER`, or `MODEL_NOT_LOADED` when the message names an unloaded model — so the turn error carries the diagnosis. Everything else, including `[DONE]` and non-JSON payloads, passes through unchanged; the shared `DONE` sentinel is now exported from the wire subpath for that comparison.

## Alternatives considered

**Relax the shared `[DONE]` framing for llama.cpp.** Rejected: a genuinely truncated generation is not a completed answer, and the framing error is the correct report for it; only the server's own error payload should take precedence over it.

**Handle the error shape inside the shared translator.** Rejected: DeepSeek never sends mid-stream error payloads, so the check would sit on a wire that cannot produce the input; the shape is llama.cpp behavior and belongs to the llama.cpp adapter.

**Map the payload through `finish_reason`-style stop reasons as pi-ai does.** Rejected: the harness stream vocabulary surfaces failures as thrown `LlmError`s with machine-routable codes, matching every other failure path through the same retry and UI classification.

## Verification

The mock router streams the exact live shape — one `{"error": …}` payload, then a close without `[DONE]` — and the adapter spec asserts the thrown message is the server's own (`decode() failed: …ErrorDeviceLost`) with code `SERVER`; the package suite covers normal streams, the not-loaded race, and the recovery paths unchanged.

## Consequences

A crashed inference device now reads as its own failure (`decode() failed: …ErrorDeviceLost`, code `SERVER`) instead of a transport framing error, so the operator is pointed at the GPU rather than the network. Per-payload JSON probing adds one parse per chunk on this route only; the shared DeepSeek wire is untouched.
