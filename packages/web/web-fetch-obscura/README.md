---
description: "The Obscura-backed fetch provider for ctx.web: anti-detect page rendering through a self-hosted single binary, with a raw status probe keeping statusCode truthful."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-fetch-obscura

English | [中文](README.zh.md)

## Summary

With `dsh-web-fetch-obscura`, the harness fetches URLs through a self-hosted [Obscura](https://github.com/h4ckf0r0day/obscura) headless browser — a single Rust binary with V8 rendering and built-in anti-detect, no browser install and no managed environment. Choose it when pages block plain HTTP clients or need JavaScript rendering and a deployment prefers self-hosting over a paid hosted fetcher. Each fetch runs a raw status probe and then a rendered dump, so `web_fetch` output carries Obscura's markdown/text/html plus a truthful HTTP status. The model-facing `web_fetch` tool lives in `dsh-tool-web`.

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

Mount the provider in a composition that already loads the web service; it registers as the `obscura` fetch provider, so `ctx.web.fetch()` resolves it automatically when it is the only usable fetch backend — or pin it with `fetchProvider: obscura`.

### When to choose it

Choose this backend when a deployment runs the Obscura binary and wants anti-bot page acquisition without a hosted paid service: Obscura renders JavaScript, rides out anti-detect checks, and obeys robots.txt by default. It is the self-hosted middle tier between the plain HTTP fetcher and a hosted paid fetcher. The provider is unavailable — and every fetch call fails with a structured error — when the configured executable is missing.

### Minimal configuration

Install Obscura under the harness home (the default), or point `commandPath` at any Obscura 0.2+ release binary:

```sh
# release asset: obscura-<platform>-stealth.zip
mkdir -p ~/.dsh/tools/obscura
unzip obscura-x86_64-windows-stealth.zip -d ~/.dsh/tools/obscura
```

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-fetch-obscura'
```

| Field | Default | Meaning |
|---|---|---|
| `commandPath` | `$DSH_HOME/tools/obscura/obscura.exe` (Windows) or `.../obscura` | Absolute path of the Obscura CLI executable; a missing file makes the provider unavailable |
| `dumpFormat` | `markdown` | Extraction format requested from the rendered page: `markdown`, `text`, or `html` |
| `statusProbe` | `true` | Probe the raw HTTP status before rendering (see the status contract below) |
| `maxBodyChars` | `50000` | Maximum returned characters for one fetch |
| `timeoutMs` | `120000` | Deadline for each of the probe and the render, in milliseconds |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-fetch-obscura) is the exhaustive source for every accepted field and its JSDoc.

### What a fetch returns

The rendered dump becomes the body: `kind: "text"` for the `markdown` and `text` formats, `kind: "html"` for `html`, capped to `maxBodyChars` with the `truncated` flag set. The `url` field carries the loaded URL the engine reports on stderr after redirects (`Page loaded: <url> - ...`), so a shortlink resolves to its destination address; when the report is absent the request URL is echoed. The status contract: the provider first requests the URL through Obscura's raw batch path, which reports the real HTTP status; a non-2xx page (a 404 error page, say) is still rendered and returned as a result carrying its true status, matching the seam's rule that a fetched non-2xx resource is a result, not an error. When the probe cannot answer — the raw path is exactly what anti-bot targets block first — a successful render reports HTTP 200, because the engine rendered a document whose exact status is unprovable; set `statusProbe: false` to skip the probe when the doubled request matters more than status fidelity.

### Failures and recovery

A failed render — navigation failure, non-zero CLI exit, deadline — surfaces as `WebError`: `OBSCURA_FETCH_TIMEOUT` past the deadline, `WEB_ABORTED` on caller cancellation, `WEB_PROVIDER_ERROR` otherwise, with the CLI's stderr tail in the message. A non-http(s) target fails as `WEB_INVALID_URL` before any process spawns. The probe never fails the fetch: its failures only degrade the result to the HTTP 200 fallback above. Callers route on the code; the model-facing `web_fetch` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over the Obscura CLI with three deliberate rules:

- **statusCode stays truthful.** Obscura's rendered-fetch path exits zero for any page the browser can display, including 4xx/5xx error pages, and exposes no HTTP status. Rendering only would have to invent a status, so the provider spends one cheap raw request on Obscura's batch path (one JSON status line per URL) and reports that status with the rendered body.
- **The probe is advisory.** The raw path is the first thing anti-bot targets block, so probe failures — block, timeout, broken exchange — degrade to the documented fallback instead of failing a fetch the renderer would have succeeded at.
- **One binary, no managed environment.** Unlike the Scrapling runtime there is no venv pipeline to create or repair: availability is one `existsSync`, and every operation is a fresh short-lived process.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, executable path resolution, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `ObscuraFetchProvider`: probe-then-render orchestration, status contract, body mapping |
| [`src/runtime.ts`](src/runtime.ts) | The `ObscuraRuntime`: subprocess exchanges with abort, timeout, and size guards; probe-line parsing |
| [`src/types.ts`](src/types.ts) | Obscura batch-path wire types: `ObscuraProbeLine` and the dump format |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Exchange flow

`fetch()` validates the target as absolute http(s), runs the probe (`fetch --quiet --file - --dump original --concurrency 1`, URL on stdin, one JSON status line back), and then the render (`fetch --quiet --dump <format> --timeout <s> <url>`, dump on stdout). Both run under `dsh-timeout` deadlines with caller-abort kill propagation, and the render is capped and flagged. A failed render throws; a failed probe only degrades the status.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive fetch request/result vocabulary and error codes.
- [Web package map](../README.md) — the web package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_fetch` tool that renders this provider's bodies.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-fetch-obscura) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's rendered markdown/text/html body, the probed HTTP status in its `Fetched <url> (HTTP <status>)` header, the `truncated` flag, and its exact `Obscura fetch timed out after <ms>ms` and `Obscura fetch failed with exit code <code>: <stderr tail>` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **The status is only as truthful as the probe** — when the raw path is blocked but the render succeeds, the result reports HTTP 200 regardless of the real page status; `statusProbe: false` widens this to every call.
- **Body extraction is limited to Obscura's dump formats** — no CSS-selector scoping, page screenshots, PDF export, or CDP/browser-control surface is exposed; those belong to a browser-automation seam, not this one.
- **Final-URL detection reads the CLI's stderr report** — when a target page floods stderr with script noise before the loaded-URL line prints, the result falls back to echoing the request URL; the rendered content is unaffected.
- **Two process spawns per fetch when the probe is on** — the CLI is fast, but latency-sensitive deployments may prefer `statusProbe: false` or the plain HTTP fetcher for unblocked pages.
- **Timeout seconds are computed per exchange** — both the probe and the render get the full `timeoutMs` each, so a worst-case fetch takes up to twice the deadline.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: fallback chains across fetch providers

The intended deployment shape is a routing tier — plain HTTP, then Obscura for blocked pages, then a hosted fetcher — which waits on provider-neutral routing fields in the web service rather than per-provider work. Tracked alongside the search-routing direction in the seam Agent Note.

</details>
