# Agent Note: Keyless Scrapling web providers over a managed Python environment

Status: implemented

English | [中文](2026-08-18-web-scrapling-keyless-providers.zh.md)

## Problem

Every shipped web search provider needs an API key (`web-search-deepseek` reuses `DEEPSEEK_API_KEY`, Exa and Perplexity their own). A deployment whose model providers are local or third-party (llama.cpp, pi-ai routes) can therefore mount the shipped `tool-web` and still have `web_search` fail with `WEB_PROVIDER_CREDENTIAL_MISSING` — the tool exists, the capability cannot run. The user's proven answer is a Scrapling-based stack (DuckDuckGo HTML search with Chrome TLS impersonation, plus anti-bot and JS-rendered fetch) that needs no keys but requires a Python runtime with `scrapling[fetchers]` installed.

Two design questions follow. First, keyless scraping is a deployment choice with security reach (a browser engine fetching model-named URLs), so it must be an explicit opt-in mount, never a shipped default. Second, the harness has no managed Python runtime for host plugins: the Python SDK drives dsh as a subprocess, it does not give host plugins an interpreter. The venv lifecycle — create, install, repair, share across concurrent first calls — needs one owner inside the provider package.

## Decision

`@deepseek-ai/dsh-web-scrapling` registers two providers into the existing `ctx.web` seam and changes no model-facing surface: `duckduckgo` (search) and `scrapling` (fetch). `dsh-tool-web` keeps owning the `web_search`/`web_fetch` schemas, so the seam's stability contract from [the web capability seam note](2026-06-24-web-capability-seam.md) is preserved — swapping in keyless providers is invisible to the model contract.

Both providers share one `ScraplingRuntime` that owns the managed Python environment:

- Setup runs at the first operation (the earliest resolvable point; setup is not self-contained at load because it needs the network), guarded by an in-flight promise so concurrent first calls share one installation; a failed setup resets the promise so the next call retries.
- Completion is a stamp file plus the venv interpreter's existence; `available()` is the cheap stamp probe unless `autoSetup: true` makes the provider optimistic for seam selection, which keeps "exactly one usable provider auto-selects" working next to a registered-but-keyless `deepseek-official`.
- A tool exit code of 3 or an `environment: true` outcome means the environment (not the operation) broke: the runtime repairs once by re-running setup and retries the operation once. Everything else is a domain `WEB_PROVIDER_ERROR`, `WEB_ABORTED`, or a provider-owned timeout code.
- The tool contract is one JSON request on argv and one JSON outcome on stdout (camelCase keys; the TypeScript request type is the single contract), bounded at 64 MiB, executed from `scripts/scrapling_tools.py` resolved beside the package lib so source and built launches share it.

Fetch-mode controls (`fetchMode`, `solveCloudflare`, `networkIdle`, `maxBodyChars`) are provider config, not tool arguments: the seam's `WebFetchRequest` is deliberately `{url}`, so stealth/dynamic acquisition and extraction scoping are deployment choices. `web-fetch-http`'s precedent of honest limits applies: no SSRF protection, stated in the README, because a scraping browser reaches what a browser reaches.

The mount is the `$DSH_HOME/cordis.patch.yml` user layer (or any `--patch` overlay): one `insert` row. Search needs nothing else — the standard preset's `tool-web` row already registers `web_search`. Enabling `web_fetch` additionally requires a user preset whose `tool-web` row sets `fetch: true`, because the shipped presets ship it disabled pending the fetch SSRF stance.

## Package topology

- `packages/web/web-scrapling/src/runtime.ts` — venv lifecycle, subprocess exchange, abort/timeout/overflow guards, repair-once.
- `packages/web/web-scrapling/src/provider.ts` — `DuckDuckGoSearchProvider`, `ScraplingFetchProvider`, outcome mapping.
- `packages/web/web-scrapling/scripts/scrapling_tools.py` — the JSON-over-argv Scrapling tool (search + three fetch modes).
- Tests cover the exchange classifier through a node fixture interpreter (no Python needed), the setup pipeline through simulated subprocess exchanges, and HMR disposal through the real seam; a `DSH_SCRAPLING_E2E`-gated e2e exercises the real venv pipeline and live queries.

## Alternatives considered

**A pure-TypeScript DuckDuckGo scraper without Python.** Node's `fetch` presents a non-browser TLS fingerprint that DuckDuckGo's HTML endpoint increasingly challenges, and the anti-bot/JS-rendered fetch modes have no Node equivalent; the Scrapling stack is proven in daily use. Keeping the subprocess also keeps one acquisition implementation across all modes instead of a TS reimplementation drifting from the Python one.

**Reusing the existing opencode plugin's lazy auto-setup verbatim.** Install-on-demand inside `execute` with cached failure state hides misconfiguration and keeps no abort/timeout/lifecycle contract. The managed runtime keeps dsh conventions: setup at the earliest resolvable point, shared across concurrent first calls, fail-loud errors carrying the exact repair commands, and one repair-then-retry instead of silent degradation.

**Registering one provider per package (mirroring `web-search-exa`).** Both providers share the venv, interpreter discovery, stamp, and repair state; splitting them would either duplicate the environment lifecycle in two packages or force a third environment-owner package for two files. One package registering one provider into each of the seam's two registries breaks no rule and keeps the shared lifecycle in one owner.

**Growing the seam's fetch request to carry mode/selector controls.** `WebFetchRequest` is deliberately `{url}`; per-request scraping controls would leak provider vocabulary into every consumer and the model contract. Deployment-level config on the provider keeps the seam provider-neutral, at the cost of one venv restart to switch modes.

## Consequences

Keyless web search and anti-bot fetch are now one opt-in row away for deployments with no search API keys, without any change to the model-facing tool contract — but the cost is a Python 3.10+ dependency, first-use setup latency (pip install, and a browser-engine download for stealth/dynamic fetch), and an honest SSRF gap documented in the README rather than silently narrowed. DuckDuckGo HTML parsing can degrade to empty results on layout change, and heavy automated use of a non-API endpoint carries rate-limit risk the harness cannot engineer away. The mount stays out of shipped defaults, so the security reach is always an explicit deployment choice.
