---
description: "The Firecrawl-backed search provider for ctx.web: keyless web search out of the box, an API key for higher limits, and one adapter for both response envelopes."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-firecrawl

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-firecrawl`, the harness searches the web through Firecrawl and gets sources with Firecrawl's result descriptions as snippets. Choose it when a deployment wants search with zero setup: an empty key runs keyless at Firecrawl's keyless rate limits, and a configured key unlocks higher limits. Firecrawl returns no generated answer, so results carry no `content` — only citeable sources. An entry with no URL in the item or its metadata is dropped, so a call can return fewer sources than requested. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `firecrawl` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: firecrawl`.

### When to choose it

Choose this backend when a deployment wants search without an account: the provider works keyless — the `Authorization` header is simply omitted — and Firecrawl meters keyless traffic by rate and concurrency instead of refusing it. A configured key raises the limits. Because the keyless mode is always usable, mounting this provider next to another search provider makes two providers usable at once; pin one explicitly or the seam fails loud with `WEB_PROVIDER_AMBIGUOUS`.

### Minimal configuration

Load the web service and the provider; every setting has a safe default, and the key falls back to `$FIRECRAWL_API_KEY` from the launch environment when present.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-firecrawl'
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | `$FIRECRAWL_API_KEY` | Firecrawl API key; empty runs keyless (no `Authorization` header, keyless rate limits) |
| `baseURL` | `https://api.firecrawl.dev` | Endpoint base; `/{version}/search` is appended. An unparseable value makes the provider unavailable |
| `apiVersion` | `v2` | API version appended to the endpoint base: `v1` or `v2`; the response envelopes differ and both are accepted |
| `numResults` | (unset) | Default result count when a request carries no `maxResults`; must be a positive integer |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-firecrawl) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each Firecrawl result maps to a `WebSearchSource`: the first non-blank of `description`/`snippet`/`metadata.description` as `snippet`, and the URL from the item or its metadata; an entry with no URL anywhere is dropped. Firecrawl returns no generated answer, so the result carries no `content`. A request's `maxResults` wins over the configured `numResults` default; the web service enforces the final bound.

### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable or wrong-shape bodies, and a `success: false` envelope — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`, so a configured credential and the POST body are never forwarded to another origin. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Firecrawl's API with three deliberate rules:

- **Keyless is a first-class mode.** An empty key omits the `Authorization` header entirely — never an empty credential — and availability rests on the endpoint alone, because keyless is how a deployment gets search with zero setup.
- **One adapter, two envelopes.** Firecrawl's v1 returns a flat `data` array and v2 returns `data.web`; the mapper accepts both so a `baseURL`/`apiVersion` pair aimed at a self-hosted or older deployment keeps working.
- **Portable snippets only.** A source's `snippet` comes from Firecrawl's description fields; URL-less entries are dropped rather than given invented addresses.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `FirecrawlSearchProvider`: request dispatch, abort classification, envelope handling, result mapping |
| [`src/types.ts`](src/types.ts) | Firecrawl wire types: `FirecrawlSearchResponse`, `FirecrawlSearchItem` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

`search()` posts the query, limit, and web source list to `{baseURL}/{version}/search` with `redirect: 'error'`, so a redirect fails the request without contacting the target. The parsed web result list is mapped one by one, URL-less entries dropped, and the service applies the final `maxResults` bound on the way back. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the web package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-firecrawl) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's URLs, titles, snippets, and its exact `Firecrawl search aborted`, `Firecrawl search request failed: <error>`, `Firecrawl search was unsuccessful: <reason>`, and `Firecrawl returned an unprocessable response body: <error>` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **An entry with no URL anywhere is dropped entirely** — there is no citeable address, so fewer sources than requested can return.
- **Keyless traffic is rate- and concurrency-limited by Firecrawl** — heavy deployment usage needs a configured key; the free monthly keyless/search budget is bounded.
- **No content extraction is requested** — the provider asks Firecrawl for result listings only, so results carry no page markdown; use a fetch provider for page bodies.
- **Only `apiVersion`/`numResults` are exposed** — Firecrawl's other controls (categories, time ranges, scrape options) wait on provider-neutral service fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: wider Firecrawl control surface

Firecrawl's categories, time ranges, and inline scrape options stay unexposed. Exposing them needs provider-neutral service fields first, so the family adds one coordinated control rather than a vendor-specific argument.

</details>
