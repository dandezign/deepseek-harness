# @deepseek-ai/dsh-web-scrapling

English | [中文](README.zh.md)

Keyless web providers for the `ctx.web` seam: a **DuckDuckGo search provider** (`id: duckduckgo`) that scrapes DuckDuckGo's HTML endpoint, and a **Scrapling fetch provider** (`id: scrapling`) that retrieves pages with Chrome TLS impersonation and readable-text extraction. Both run through [Scrapling](https://github.com/D4Vinci/Scrapling) in a managed Python virtual environment — no search API keys.

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-web` | Service Definition: `ctx.web`, provider registries, selection policy |
| `@deepseek-ai/dsh-web-scrapling` (this) | Search provider (DuckDuckGo) + fetch provider (Scrapling), one shared managed venv |
| `@deepseek-ai/dsh-tool-web` | Consumer: the model-facing `web_search` / `web_fetch` tools |

## Providers

The search provider maps each parsed DuckDuckGo result to a `WebSearchSource` (`url` required; empty titles/snippets omitted; entries without a URL dropped). It never produces `content` or `publishedAt`, and reports `truncated: false` — the seam owns the `maxResults` truncation. Requests carry no credentials.

The fetch provider validates the target as an absolute http(s) URL (`WEB_INVALID_URL` otherwise) and acquires it in the configured mode:

| Mode | Acquisition |
|---|---|
| `standard` (default) | plain HTTP with stealthy headers and Chrome TLS impersonation, 30s request timeout |
| `stealth` | headless stealth browser (Cloudflare challenge solving optional), ad/resource blocking |
| `dynamic` | full headless-browser automation with JS rendering (`networkIdle`, `waitSelector` optional) |

Extraction always yields `WebFetchBody` `kind: "text"`: trafilatura readable text with a markdownify fallback. A non-2xx page is a result (the Python tool reports the page status), not a throw. Stealth/dynamic modes download a browser engine during setup (`playwright install chromium`).

## Managed Python environment

Both providers share one runtime that manages a venv under `venvRoot` (default `$DSH_HOME/web-scrapling`):

- `autoSetup: true` (default): on first use, locate a Python 3.10+ interpreter (`pythonCommand` overrides the platform candidates `python`/`py -3` on Windows, `python3`/`python` elsewhere), create the venv, install `scrapling[fetchers]` (plus the browser engine when the fetch mode needs one), and stamp completion. Concurrent first calls share one setup; a failed setup is retried by the next call.
- `autoSetup: false`: the venv must already exist; otherwise the first operation fails loud with the exact commands to run (`WEB_PROVIDER_UNAVAILABLE`).
- A broken environment (the tool exits 3 or reports an import failure) is repaired once by re-running setup, then the operation retries.

Cancellation and deadlines kill the child process (`WEB_ABORTED`, or the provider-owned `SCRAPLING_SEARCH_TIMEOUT` / `SCRAPLING_FETCH_TIMEOUT` codes). The tool exchange is one JSON request on argv and one JSON outcome on stdout, bounded at 64 MiB.

## Config

| Key | Default | Meaning |
|---|---|---|
| `pythonCommand` | platform candidates | base Python 3.10+ interpreter for venv creation |
| `venvRoot` | `$DSH_HOME/web-scrapling` | directory receiving the managed venv |
| `autoSetup` | `true` | create and install the venv on first use |
| `fetchMode` | `standard` | `standard` / `stealth` / `dynamic` acquisition |
| `solveCloudflare` | `false` | stealth mode: attempt Cloudflare challenge solving |
| `networkIdle` | `false` | dynamic mode: wait for network idle |
| `maxBodyChars` | `50000` | maximum extracted characters per fetch |
| `searchTimeoutMs` | `120000` | deadline for one search exchange |
| `fetchTimeoutMs` | `180000` | deadline for one fetch exchange |
| `setupTimeoutMs` | `600000` | bound for the whole one-time setup pipeline |

Selection: with no configured id, these providers auto-select when they are the only **usable** provider — a registered but keyless `deepseek-official` search provider is not usable, so mounting this package alone is enough. If another usable fetch provider is also mounted (for example `web-fetch-http`), configure the seam's `fetchProvider` explicitly or the seam throws `WEB_PROVIDER_AMBIGUOUS`.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-web`, which owns the `web_search` / `web_fetch` tool schemas, prompt guidance, and result presentation; this package contributes only normalized provider data or a thrown `WebError` code.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **No SSRF protection** — the scrapling fetcher reaches any http(s) target the model names, including private networks a browser can access; the stealth/dynamic modes add a full browser engine to that reach. Do not enable where it can reach sensitive internal targets.
- **DuckDuckGo HTML endpoint is not an API** — result parsing depends on the endpoint's stable HTML shape; a 200 page with no parseable results degrades to empty sources, while a non-200 anomaly or rate-limit response fails loud as `WEB_PROVIDER_ERROR` instead of reading as an empty result.
- **Per-request fetch controls are provider config, not tool arguments** — the seam's `WebFetchRequest` is `{url}` only; `cssSelector`-style extraction scoping stays deferred until the seam grows provider-neutral fetch controls ([seam design](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **StealthyFetcher's own browser is installed on first stealth use by Scrapling** — setup installs the Playwright Chromium engine for the dynamic mode; the stealth mode's Camoufox engine downloads on its first invocation and is not covered by `setupTimeoutMs`.

No runtime invariant companion is published because the providers own no event sequence or mutable relation; every outcome is one subprocess exchange's JSON verdict carried through the `ctx.web` seam.
