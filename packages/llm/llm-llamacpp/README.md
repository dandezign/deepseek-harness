---
description: "llama.cpp adapter for the harness LLM seam: OpenAI-compatible chat plus the ensure-loaded lifecycle, discovery, and settings card a multi-model router needs."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-llamacpp

English | [中文](README.zh.md)

## Summary

llama.cpp adapter for the harness LLM seam: chat through the server's OpenAI-compatible endpoint plus the model lifecycle a multi-model router needs — ensure-loaded before each request, one load-and-retry on the router's not-loaded race, optional unload-after-switch, and model discovery that reads context windows and vision capability from the live listing. One plugin instance owns the single `llamacpp` provider route and mounts **dormant** until settings supply a `baseURL`.

The chat wire (SSE framing, chunk translation, usage mapping, message serialization) is shared with [`dsh-llm-deepseek`](../llm-deepseek/README.md); what this package owns is everything llama.cpp-specific.

## Table of Contents

- [Config](#config)
- [Model lifecycle](#model-lifecycle)
- [Discovery](#discovery)
- [Errors](#errors)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

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

`baseURL` is the server **origin**, not the OpenAI-compatible prefix: the control surface (`/props`, `/models/load`, `/models/unload`) lives beside `/v1`, not under it. A pasted `http://host:8080/v1` is normalized rather than rejected. Falls back to `$LLAMACPP_BASE_URL` from a trusted environment layer; without any endpoint the plugin mounts dormant — zero routes, the Models-page card still offered — and serves the route the moment the `llm-llamacpp:` settings section supplies one.

The credential is **optional**: a llama.cpp server launched without `--api-key` accepts anonymous requests, so an unresolvable reference degrades to no `Authorization` header rather than failing every request (the opposite of the hosted-provider adapters, where `MISSING_CREDENTIAL` is the right answer). A server that does enforce a key rejects the anonymous request with `AUTH`. The directory entry declares `credentialOptional`, so the Models page treats a live keyless route as usable and never badges it "API key missing".

## Model lifecycle

Observed against llama.cpp build `b10443-27df9199d`; the adapter probes `GET /props` once per configuration generation (carrying the bearer token when one resolves — a server launched with `--api-key` answers an anonymous probe with 401) and degrades to a no-op lifecycle on anything but `role: "router"`, so a plain single-model server behaves exactly as before.

**[Strata](https://github.com/Niko1221/Strata) servers are managed too.** Their `/props` carries no `role`, so the adapter identifies them by the `models_autoload` marker (with `build_info: "Strata …"` confirming) and drives the whole-server `POST /load` / `POST /unload` instead of the router's per-model calls; a `409` from `/load` means a request is already in flight, so the model is resident and the wait proceeds. Residency comes from the `/v1/models` listing, which a non-resident Strata answers with an empty array — a listed-but-missing model therefore reads `unloaded`, not unknown — and discovery falls back to `/props`, whose `model_alias` names the served model with its context window and vision capability even while asleep. The `/models/sse` stream is left alone: polling covers the transitions.

- **Before each request** (`autoLoad`, default on): read the model's live status from `/v1/models`; `loaded` proceeds immediately, anything else posts `POST /models/load` and polls until resident, bounded by `loadTimeoutMs`. Concurrent requests for one model share a single in-flight wait; a model that falls back to `unloaded` mid-wait gets exactly one re-issued load.
- **The not-loaded race**: another client can unload the model between the pre-flight check and the chat POST, and the router answers that with `400 {"message":"model is not loaded"}` — classified `MODEL_NOT_LOADED` by the shared classifier in `dsh-llm`. The adapter recovers once — re-ensure, retry the request — before surfacing the error.
- **Switching**: loading model B evicts A on the router's own at `max_instances: 1`, so switching models in the picker just works; the first request after a switch pays the load. `autoUnload: on-switch` additionally unloads previously resident models once no in-flight request holds them (per-model refcounts) — hygiene for multi-instance servers, where the router does not evict.
- **Progress**: each load transition is emitted on the Host event `llm/model-load-progress` (`{provider, model, phase: 'loading' | 'ready' | 'failed', message?}`) at its commit point — when the load is issued or joined, and when it settles. Progress is transport state: never model-visible, never session-logged; the web session UI renders it as the load/switch banner. An already-resident model emits nothing.
- **Thinking control**: models expose the vocabulary their chat templates actually read, verified by rendering each template through `/apply-template` (build `b10443-27df9199d`): the Qwen3.8 family maps a graded `reasoning_effort` — **low / medium / xhigh**, xhigh the template default — and raises a server error on any other value (high and max included); Qwen3.6- and Qwen2.5-era templates ignore `reasoning_effort` entirely. **Off** rides `enable_thinking: false`, which every family tested honors. No level is the default: an unselected session sends no kwargs and the template's own default governs (xhigh on Qwen3.8, plain thinking on Qwen3.6).
- **Scope**: the adapter manages models over the wire only. It never starts, restarts, or supervises `llama-server` itself, and it leaves the server's `models_autoload` setting untouched — that remains the deployment's one-line alternative to `autoLoad`.

## Discovery

`Fetch available models` on the configuration card interrogates `GET /v1/models` through `ctx.llm.registerModelDiscovery('llm-llamacpp', …)`. The router's listing discloses more than the OpenAI-compatible minimum, and the reader surfaces it:

- `status.args` → `--ctx-size` → the model's **context window** (the number a generic reader leaves to a manual setting);
- `architecture.input_modalities` → vision vs text-only metadata;
- live `status.value` → which model is resident right now.

Nothing is stored by discovery; adopting candidates updates the draft, `settings.yaml` remains the only catalog authority. A model neither configured nor sized falls back to `defaultContextWindow` (32,768 — llama.cpp's own default) and `maxTokens` (8,192).

## Errors

Non-2xx chat responses throw `LlmError` through the same `httpErrorCode` mapping the DeepSeek adapter owns: `AUTH` (401/403), `QUOTA`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, **`MODEL_NOT_LOADED`** (a recognized-but-unloaded model), `INVALID_REQUEST` (other 400s), `SERVER` (5xx), `HTTP_<status>` otherwise. Load waits that exceed `loadTimeoutMs` throw `TIMEOUT`; transport failures name the endpoint and chain the cause. Every request carries the shared attribution header from dsh-llm's `attributionHeaders()`.

A mid-stream failure arrives as a terminal `data: {"error": …}` payload followed by a close without `[DONE]` — a Vulkan device loss during decode is the common case. The adapter surfaces that payload's own message through the same mapping (typically `SERVER`), so the turn error names the failure instead of the framing.
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The adapter's settings card, load-progress event, and lifecycle decisions are owned by [the llama.cpp settings card note](../../../.agents/notes/implemented/architecture/2026-08-16-llamacpp-settings-card-and-load-progress.md); the shared chat wire ships as the built `./wire` subpath of `dsh-llm-deepseek` so plain-Node profile boots and the tsx source launch resolve identically.

</details>


## Model Experience

### llama.cpp request

#### What the model sees

The selected model receives `GenerateOptions.system`, history, tools, and sampling fields serialized onto the shared chat-completions wire. This adapter adds no prompt prose. `reasoningEffort` maps onto `chat_template_kwargs` — `low`/`medium`/`xhigh` onto `reasoning_effort`, `off` onto `enable_thinking: false`; an absent effort sends no kwargs and the chat template's own default governs.

#### Token effect

Provider tokenization governs exact input; conversion adds no model-visible text. `cacheReadTokens` maps from `prompt_tokens_details.cached_tokens`, which llama.cpp reports natively.

#### KV Cache effect

Conversion preserves logical request order without adding text; llama.cpp's own prefix caching governs reuse. Switching models mid-session changes the request target and defeats reuse from the first differing token, exactly as switching models on any provider does.

### llama.cpp response

#### What the model sees

`reasoning_content` deltas (thinking templates) become harness reasoning blocks; `content` becomes text; tool-call deltas concatenate per wire index; `finish_reason` and usage arrive deferred to `[DONE]`, as on the DeepSeek wire.

#### Token effect

Generated content affects later inputs only after the loop records it. Reasoning tokens map when `completion_tokens_details` reports them.

#### KV Cache effect

Recorded response content appends to the next request and does not invalidate its earlier reusable prefix. Transport metadata and usage accounting do not affect cache identity.

## Known Limitations and Deferred Work

- **Vision needs both a projector and a declaration** — images serialize as OpenAI-style `image_url` content parts, which only a server started with a matching `--mmproj` can read. The adapter cannot detect that, so a model carries `inputModalities: [text, image]` in its catalog entry (`Fetch available models` proposes it from the live listing) and the host refuses images for every model without it, before they are attached.
- **A dropped `/models/sse` connection loses in-flight transitions** — the watcher reconnects and the listing safety net converges the state, so a wait still settles; what a drop costs is promptness, not correctness. The watcher never becomes a dependency: set `watchEvents: false`, or run a build that 404s the stream, and the lifecycle polls exactly as it did before.
- **A named route states its own endpoint** — `$LLAMACPP_BASE_URL` names one server, so it fills in the default `llamacpp` route only; a `providers` entry without its own `baseURL` stays dormant rather than silently addressing the same box. Declaring the endpoint both at the top level and as `providers.llamacpp` is refused, because the two would disagree about which server the default route means.
- **A pi-ai route named `llamacpp` collides** — `DUPLICATE_ADAPTER`, by design: remove the route out of the `llm-pi-ai:` section when adopting this adapter, because lifecycle management is why you are moving it. The registration failure names that removal in the host log.
- **Thinking levels are the templates' own, not a universal scale** — only the Qwen3.8 family reads `reasoning_effort` (low/medium/xhigh; high and max are rejected with a server error, so the adapter refuses them client-side). Nothing on the wire announces which template a model uses, so a model that reads fewer levels pins them in its catalog entry: `reasoningEfforts: [off]` on a Qwen3.6-era model stops the picker offering graded levels that would silently do nothing. Omitted still offers the full vocabulary.
- **Control calls share the chat timeout vocabulary** — `loadTimeoutMs` covers one whole load; there is no separate per-POST control timeout.

No runtime invariant companion is published because the adapter owns no event sequence or durable mutable relation; lifecycle and listing state live in the `llm` registry's owned structures, asserted by the registry's own companion.
