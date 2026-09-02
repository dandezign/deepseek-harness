#!/usr/bin/env python3
"""Scrapling-based web tools for @deepseek-ai/dsh-web-scrapling.

One JSON request object arrives as the sole argv argument; one JSON outcome
object is printed to stdout and the process exits 0. A `null` outcome is never
produced: a domain failure is `{"error": "..."}`, and only an unusable
interpreter environment (scrapling import failing) exits non-zero after
printing its JSON error, so the caller can distinguish "retry the setup" from
"the operation failed".

Request shapes (camelCase keys; the TypeScript request object is the contract):
    {"op": "search", "query": "...", "numResults": 10}
    {"op": "fetch", "url": "...", "mode": "standard|stealth|dynamic", "maxChars": 50000,
     "cssSelector": null, "solveCloudflare": false, "networkIdle": false, "waitSelector": null}
"""

import json
import sys

# Force UTF-8 stdio on Windows (cp1252 cannot round-trip page content).
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


def emit(outcome):
    print(json.dumps(outcome, ensure_ascii=False))
    sys.stdout.flush()


def die(message):
    emit({"error": message})
    sys.exit(1)


try:
    from scrapling.fetchers import Fetcher, StealthyFetcher, DynamicFetcher
except ImportError:
    # Non-zero exit marks the environment (not the operation) as broken so the
    # caller re-runs its managed setup instead of surfacing a provider error.
    emit({"error": "scrapling is not installed in the managed venv", "environment": True})
    sys.exit(3)


def search_web(query, num_results):
    """Search DuckDuckGo's HTML endpoint and return normalized results."""
    try:
        from urllib.parse import quote, unquote

        url = f"https://html.duckduckgo.com/html/?q={quote(query)}"

        page = Fetcher.get(url, stealthy_headers=True, impersonate="chrome", timeout=15)

        # DuckDuckGo answers rate-limited or fingerprint-flagged clients with a
        # challenge shell under a non-200 status (observed as 202). Parsing that
        # page yields zero results indistinguishable from an empty result page,
        # so report it as a domain error instead.
        status = getattr(page, "status", 200) or 200
        if status != 200:
            return {
                "error": f"HTTP {status} instead of a results page (anti-bot anomaly response or rate limit); no results were served",
                "results": [],
                "count": 0,
            }

        results = []

        def unwrap(href):
            if href.startswith("//duckduckgo.com/l/?uddg="):
                return unquote(href.split("uddg=")[1].split("&")[0])
            return href

        for result in page.css(".result")[:num_results]:
            title_el = result.css(".result__a")
            if not title_el:
                continue
            snippet = ""
            snippet_el = result.css(".result__snippet")
            if snippet_el:
                snippet = snippet_el[0].get_all_text(separator=" ", strip=True) or snippet_el[0].text or ""
            results.append({
                "title": title_el[0].text or "",
                "url": unwrap(title_el[0].attrib.get("href", "")),
                "snippet": snippet,
            })

        if not results:
            for link in page.css("a.result__a")[:num_results]:
                title = link.text or ""
                if not title:
                    continue
                snippet = ""
                parent = link.parent
                if parent:
                    snippet_el = parent.css(".result__snippet")
                    if snippet_el:
                        snippet = snippet_el[0].get_all_text(separator=" ", strip=True) or snippet_el[0].text or ""
                results.append({
                    "title": title,
                    "url": unwrap(link.attrib.get("href", "")),
                    "snippet": snippet,
                })

        return {"results": results, "count": len(results)}

    except Exception as e:  # noqa: BLE001 - one boundary reports every failure shape
        return {"error": str(e), "results": [], "count": 0}


def extract_content(page, css_selector):
    """Extract readable text via trafilatura, falling back to raw markdownify."""
    try:
        if css_selector:
            elements = page.css(css_selector)
            return "\n".join(el.get_all_text(separator="\n", strip=True) for el in elements)

        import trafilatura
        result = trafilatura.extract(
            page.html_content,
            include_comments=False,
            include_tables=True,
            include_links=True,
            output_format="txt",
        )
        if result and len(result) > 200:
            return result
    except Exception:  # noqa: BLE001 - extraction falls through to the raw path
        pass

    try:
        from markdownify import markdownify
        return markdownify(page.html_content)
    except ImportError:
        return page.get_all_text(separator="\n", strip=True)


def fetch_url(req):
    """Fetch one URL with the configured scrapling fetcher and extract text."""
    url = req.get("url") or ""
    mode = req.get("mode") or "standard"
    max_chars = int(req.get("maxChars") or 50000)
    css_selector = req.get("cssSelector") or None

    try:
        if mode == "stealth":
            page = StealthyFetcher.fetch(
                url,
                headless=True,
                solve_cloudflare=bool(req.get("solveCloudflare")),
                block_ads=True,
                disable_resources=True,
                timeout=60000,
            )
        elif mode == "dynamic":
            kwargs = {"headless": True, "disable_resources": True, "timeout": 60000}
            if req.get("networkIdle"):
                kwargs["network_idle"] = True
            if req.get("waitSelector"):
                kwargs["wait_selector"] = req["waitSelector"]
            page = DynamicFetcher.fetch(url, **kwargs)
        else:
            page = Fetcher.get(url, stealthy_headers=True, impersonate="chrome", timeout=30)

        content = extract_content(page, css_selector)
        return {
            "url": url,
            "status": getattr(page, "status", 200) or 200,
            "content": content[:max_chars],
            "truncated": len(content) > max_chars,
        }

    except Exception as e:  # noqa: BLE001 - one boundary reports every failure shape
        return {"error": str(e), "url": url, "status": 0, "content": ""}


def main():
    if len(sys.argv) != 2:
        die("expected exactly one JSON request argument")

    try:
        req = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        die(f"invalid JSON request: {e}")

    op = req.get("op")
    if op == "search":
        query = req.get("query")
        if not isinstance(query, str) or not query:
            die("search requires a non-empty query")
        num_results = int(req.get("numResults") or 10)
        emit(search_web(query, num_results))
    elif op == "fetch":
        url = req.get("url")
        if not isinstance(url, str) or not url:
            die("fetch requires a non-empty url")
        emit(fetch_url(req))
    else:
        die(f"unknown op: {op}")


if __name__ == "__main__":
    main()
