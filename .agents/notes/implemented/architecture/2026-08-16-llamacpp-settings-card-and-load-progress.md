# Agent Note: llama.cpp settings card, optional credentials, and load progress on the forwarded-event channel

Status: implemented

English | [中文](2026-08-16-llamacpp-settings-card-and-load-progress.zh.md)

> Scope: how the `llamacpp` provider became a first-class Models-page citizen, why its optional credential is a directory field rather than a UI special case, and why model-load progress rides `llm/model-load-progress` instead of a session event or a mux frame.

## Problem

Three failures surfaced together the first time a real llama.cpp router was driven from the web UI. (1) The Models page rendered the `llm-llamacpp` settings namespace under its `unknown` layout — a hint line and a permanently disabled Apply — so the provider could not be configured from the UI at all; users fell back to a generic `llm-pi-ai` route, which classifies `MODEL_NOT_LOADED` but cannot load anything, and the raw `400 "model is not loaded"` reached the turn. (2) The router probe `GET /props` was sent without the bearer token, so a server launched with `--api-key` answered 401, the lifecycle disabled itself, and the same 400 surfaced even on the dedicated adapter. (3) A load that takes minutes happens entirely inside the host adapter; nothing told the user their model switch was progressing.

## Decision

**The settings card is an adapter-family layout, and the optional credential is an adapter-declared directory field.** `ProviderEditor` gained a `llamacpp` family beside `deepseek` and `pi-ai` (endpoint, key with an optional-key placeholder, and the shared `ModelListEditor` whose fetch action is the pre-save connection test and candidate picker). `LlmConfigurableProvider.credentialOptional` (projected through `llm.providers` as `ConfigurableProviderView.credentialOptional`) states the fact only the adapter knows: this route serves requests with no stored credential. `providerUsable` and the missing-key dot read that field instead of the UI naming provider ids — the same "only the adapter can answer" reasoning as `declared`.

**Load progress is a one-way typed Host event on the forwarded-event channel.** `llm/model-load-progress` (`{provider, model, phase: 'loading' | 'ready' | 'failed', message?}`) is emitted by the lifecycle at each transition's commit point — when a load is issued or joined, and when it settles — and never for an already-resident model. It is transport state, not model input, so it is not a session event (model-visible ⟺ logged) and not a `MuxFrame` variant (session-scoped whole-snapshot state with reconnect baselines); it is one entry in `API_REMOTE_FORWARDED_EVENTS`, which the existing shape gate holds to real, non-scoped, one-way events. `ui-model-selection`'s service subscribes through `ctx.remote.$on` and holds a `SnapshotStore` the composer model seat renders as the load/switch banner; terminal states self-clear after a hold unless a newer load replaced them. Reconnect gaps lose in-flight frames — acceptable for a transient banner, convergent through the terminal event and `llm/adapters-updated`.

## Consequences

- `/props` carries the resolved bearer token: an authed router keeps its lifecycle, which is what makes the load-and-retry path (and the popup) fire on exactly the servers that need it.
- The web settings page needs no new wire method: the fetch action already asks the endpoint the draft shows, so "test the connection before saving" is the same round trip as "list models to adopt".
- A provider whose key is genuinely required is unaffected: `credentialOptional` absent means the old semantics everywhere.

## The route collision a real deployment hit

A first real deployment kept its old hand-declared `llm-pi-ai.providers.llamacpp` section while adding the new section. pi-ai registered the route first, so the dedicated plugin's `registerAdapter` threw `DUPLICATE_ADAPTER` inside its settings-change callback — contained, logged generically, and invisible in the UI, while every chat kept hitting the pi-ai adapter and failing with `MODEL_NOT_LOADED` (pi-ai classifies the wording but cannot load anything). The fix keeps the one-route-one-adapter design and makes the failure name its remedy: the plugin rethrows the duplicate with "remove the duplicate entry from the llm-pi-ai settings section", and the README adoption note says the same. The deployment's own settings were migrated by moving the curated model list into `llm-llamacpp:` (the migration drops the pi-ai route's image input; the dedicated adapter is text-only v1).

## Thinking control: the template's own vocabulary, verified by rendering it

llama.cpp chat templates own thinking control, and templates disagree. Rather than guess, the vocabulary was established by rendering each family's template through `POST /apply-template` (no token generation) on the live router build `b10443-27df9199d`: Qwen3.8-27B maps a graded `reasoning_effort` — low / medium / xhigh, xhigh the template default — and raises a Jinja server error on any other value (`high` and `max` included); Qwen3.6-12B ignores `reasoning_effort` entirely; Qwen2.5 ignores both variables. Every family tested honors `enable_thinking: false` for off. The adapter therefore declares exactly `low / medium / xhigh / off`: the graded levels ride `chat_template_kwargs.reasoning_effort` (harmlessly ignored where unread), `off` rides `enable_thinking`, unsupported values are refused client-side with `INVALID_REQUEST` instead of a provider 500, and there is **no adapter default** — an unselected session sends no kwargs and the template's own default governs. A requested `high`/`max` vocabulary was declined on this evidence: the model would reject both on every request.
