# Agent Note: Obscura fetch provider keeps statusCode truthful through a status probe

Status: implemented

English | [中文](2026-09-06-web-fetch-obscura-provider.zh.md)

## Problem

The seam's fetch contract reports the fetched resource's HTTP status, and `tool-web` renders it to the model (`Fetched <url> (HTTP <status>)`). The Obscura headless browser is an attractive self-hosted anti-detect fetch backend, but its rendered-fetch path exits zero for any page the browser can display — including 4xx/5xx error pages — and exposes no HTTP status. A fetch provider that only rendered would have to invent a status: a 404 error page would reach the model labeled HTTP 200.

## Decision

`web-fetch-obscura` registers as the `obscura` fetch provider and runs each fetch in two steps:

1. **Status probe (advisory, `statusProbe: true` by default).** One request through Obscura's raw batch path (`fetch --quiet --file - --dump original --concurrency 1`, URL on stdin), which prints one JSON status line per URL carrying the real HTTP status. The line's `ok` flag is ignored for status extraction: `ok` means 2xx/3xx, and a 404 line is exactly where the real status matters. A non-2xx page is still rendered and returned as a result carrying its true status, matching the seam's rule that a fetched non-2xx resource is a result, not an error.
2. **Render.** `fetch --quiet --dump <format>` returns the page body (markdown/text/html) on stdout.

When the probe cannot answer — blocked raw path, timeout, broken exchange, unparseable line — a successful render reports HTTP 200, because the engine rendered a document whose exact status is unprovable; the fallback is a documented contract (README "What a fetch returns"), never a fabricated error status. `statusProbe: false` skips the probe for latency-sensitive deployments. The probe never fails the fetch: the raw path is what anti-bot targets block first, and the renderer may still succeed. The runtime is deliberately environment-free — availability is one `existsSync` on the configured binary, every operation is a fresh short-lived process, and the `dsh-timeout` deadline/abort machinery plus the stdout size cap mirror the Scrapling runtime's guards.

## Alternatives considered

**Report 200 for every successful render.** Rejected: model-visible output must not lie; the model uses the status to recognize error pages, and the common case (soft-404 pages that render fine) would mislead it silently.

**Derive status from the render via `--eval` or page content.** Rejected: post-navigation JavaScript cannot see the HTTP status of the navigation response; any heuristic on page content is worse than the one cheap raw request.

**Parallelize probe and render.** Deferred: sequential keeps error attribution single (render errors always win) at the cost of one fast raw round-trip; the provider targets slow anti-bot pages where the saving is noise.

## Verification

The package suite covers probe-line parsing (including non-2xx lines and trailing-noise tolerance), the probe/render orchestration against a scripted in-memory runtime (real 404 carried through, fallback 200 on probe failure, probe skip, html/text body kinds, truncation, error and abort classification, exact CLI argv and stdin), real-process fixture coverage for spawn/kill/timeout/exit-code paths, plugin registration and auto-selection through `ctx.web`, and an env-gated e2e against the real binary asserting example.com renders with HTTP 200 and a real 404 reports 404 — both exercised live against Obscura 0.2.2 on Windows.

## Consequences

A deployment gains the self-hosted middle tier between the plain HTTP fetcher and a paid hosted fetcher. The cost is at most one extra raw request per fetch (skippable) and a documented 200-fallback window when the raw path is blocked while the render passes. The intended routing shape — HTTP, then Obscura, then a hosted fetcher — still waits on provider-neutral routing fields in the web service.
