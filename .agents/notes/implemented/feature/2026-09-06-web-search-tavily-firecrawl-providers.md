# Agent Note: Tavily and Firecrawl search providers join the web seam

Status: implemented

English | [中文](2026-09-06-web-search-tavily-firecrawl-providers.zh.md)

## Problem

The web seam shipped five search backends (Exa, Perplexity, DeepSeek, DuckDuckGo-over-Scrapling) but left a deployment without vendor accounts few good options: DuckDuckGo HTML scraping is the only keyless route and it is the one most often IP-blocked. Tavily offers a recurring free credit tier without a credit card, and Firecrawl launched a keyless search mode metered by rate instead of keys; neither was reachable from the harness.

## Decision

Two new search providers register into `ctx.web` under the established plugin shape, each mounting by deployment patch like `web-scrapling`:

- `web-search-tavily` (`tavily`): requires an API key (env fallback `$TAVILY_API_KEY`), clamps the outgoing `max_results` to Tavily's documented API maximum of 20 while the seam still enforces the caller's original bound, maps Tavily's `content` to `snippet`, and carries the generated answer as `content` when `includeAnswer` is on — the same treatment Perplexity's answer gets.
- `web-search-firecrawl` (`firecrawl`): keyless is a first-class mode — an empty key omits the `Authorization` header entirely and availability rests on the endpoint alone — and one mapper accepts both the v1 flat `data` array and the v2 `data.web` envelope so self-hosted or older endpoints keep working.

Both providers reject redirects before the `Location` target is contacted, with real-HTTP-server coverage proving the target is never reached (packages/web/AGENTS.md credential rule); the demonstration case uses a custom credential header because the fetch spec strips `authorization` on cross-origin redirects, which is exactly the hole the policy exists to cover.

## Alternatives considered

**Mount the new providers in the shipped base bundle.** Rejected: the base pins `searchProvider: deepseek-official`, and a always-usable keyless provider mounted beside other providers widens `WEB_PROVIDER_AMBIGUOUS` to every deployment that clears its pin. Non-default providers stay opt-in via patch, following the `web-scrapling` and `web-search-exa` precedent.

**Clamp Firecrawl's limit like Tavily's.** Rejected: Tavily errors above 20 while Firecrawl accepts higher limits; a clamp here would silently narrow a caller's legitimate bound without a server-side reason.

## Verification

Each package carries a mocked-fetch spec (mapping, availability, request shape, abort/HTTP-error classification, HMR-safe registration into `ctx.web`), a real-HTTP-server redirect spec, and an env-gated live e2e; the Firecrawl e2e runs keyless and was exercised live. `pnpm run typecheck`, `pnpm run build`, and the three packages' suites pass.

## Consequences

A deployment gains a no-card free-tier search route (Tavily) and a zero-setup keyless route (Firecrawl) beside the IP-fragile DuckDuckGo scraper. The provider families grow by two plugins with no seam change; the wider control surfaces (domain filters, time ranges) still wait on provider-neutral service fields per the seam note.
