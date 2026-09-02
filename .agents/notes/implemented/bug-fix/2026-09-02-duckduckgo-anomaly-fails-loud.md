# Agent Note: DuckDuckGo anomaly responses surface as provider errors instead of empty results

Status: implemented

English | [中文](2026-09-02-duckduckgo-anomaly-fails-loud.zh.md)

## Problem

DuckDuckGo answers rate-limited or fingerprint-flagged clients with a challenge shell under a non-200 status (served as HTTP 202 in the field) rather than an error. The search tool parsed that shell like any response, found no result links, and returned an outcome indistinguishable from a legitimate empty result, so a blocked or throttled deployment read as "No results found." — the model saw a normal answer, cited nothing, and neither the transcript nor error metadata carried the block.

## Decision

`scripts/scrapling_tools.py` checks the response status after the fetch: any non-200 status returns a domain-error outcome naming the status and the anti-bot/rate-limit cause, and the provider's existing error-outcome mapping surfaces that message verbatim as `WEB_PROVIDER_ERROR`. A 200 page that parses to zero results stays an honest empty result: genuine no-hit queries exist, and a layout change on a 200 response remains the silent-degradation mode documented under Known Limitations in the package README.

## Alternatives considered

**Error only on 202.** Rejected: 403, 429, and 5xx responses equally carry no results page; any non-200 means the result HTML is absent, so one status check covers the whole family without maintaining a block-status list.

**Error on every empty result, including 200.** Rejected: no-hit queries are normal answers, and turning them into failures would make the tool unusable for narrow queries while hiding which queries legitimately return nothing.

**Escalate a challenged search to the stealth or dynamic fetcher.** Rejected: silently retrying through a browser engine converts a loud block into a slow success, multiplies the resource cost of rate-limited bursts, and deepens the fingerprint pressure that triggered the block.

## Verification

The exchange-classifier spec covers error-outcome mapping through the node fixture (`domain-error`), and the `DSH_SCRAPLING_E2E` suite exercises the live endpoint; a blocked deployment rejects with `WEB_PROVIDER_ERROR` carrying the status instead of resolving empty.

## Consequences

Rate-limited or flagged deployments see `web_search` fail with a descriptive error naming the HTTP status, making the block diagnosable from the transcript; an empty result now means the endpoint answered 200 with no parseable hits. Distinguishing a hard block from a transient throttle still requires human judgment; the error message names both causes.
