// The real Invesco HTTP client — the ONE module that touches the network, so (like the sibling
// iShares / Vanguard workers' clients) it is exercised live, not by the unit tests, which drive the
// pure driver in invesco.ts through an injected fake `get`.
//
// Invesco's public cache-CDN endpoints (dng-api.invesco.com) are keyless and un-gated, so there is
// no login/token handshake. Two non-obvious requirements:
//   • A browser-like User-Agent + a `Referer: https://www.invesco.com/` — the default fetch UA is
//     rejected.
//   • Transient 503s. The Fastly/Varnish edge intermittently returns 503 on a cold cache node; a
//     short retry with backoff turns those into 200s (verified against the fundCharacteristics
//     resource). So the client retries idempotent GETs on 5xx.
//
// CATALOG CACHE: the /product/search catalog backs both `products` and every ticker→CUSIP
// resolution, and it changes at most once a day. So the client memoizes just that one URL with a
// 24 h TTL (shared across queries in a long-lived stdio/HTTP process). Everything else — holdings,
// fund_details, distributions, nav_history — always goes live. The in-flight Promise is cached (not
// only the resolved value) so concurrent first requests coalesce into a single fetch; a failed
// fetch is evicted so the next call retries.

import type { InvescoGet } from "./functions.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Default catalog cache lifetime: 24 hours. */
export const CATALOG_CACHE_MS = 24 * 60 * 60 * 1000;
/** How many times to retry a GET that returns a 5xx (the edge's transient 503s). */
export const MAX_RETRIES = 4;

type FetchLike = typeof globalThis.fetch;

export interface InvescoClientOptions {
  /** Catalog cache TTL in ms (default 24 h). Pass 0 to disable caching. */
  catalogCacheMs?: number;
  /** Injectable clock (ms since epoch) — for tests. Defaults to Date.now. */
  now?: () => number;
  /** Max 5xx retries (default MAX_RETRIES). */
  maxRetries?: number;
  /** Injectable sleep (ms) — for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the injectable `get(url) => parsed JSON` the table functions call. `fetchImpl` defaults
 * to the platform fetch; pass one in for Cloudflare or to stub the network. The /product/search
 * catalog response is memoized for `catalogCacheMs` (default 24 h); 5xx responses are retried.
 */
export function makeInvescoGet(
  fetchImpl: FetchLike = globalThis.fetch,
  opts: InvescoClientOptions = {},
): InvescoGet {
  const ttl = opts.catalogCacheMs ?? CATALOG_CACHE_MS;
  const now = opts.now ?? (() => Date.now());
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let catalog: { at: number; value: Promise<unknown> } | null = null;

  const rawGet = async (url: string): Promise<unknown> => {
    let lastBody = "";
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetchImpl(url, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json,*/*",
          Referer: "https://www.invesco.com/",
        },
      });
      if (res.ok) return res.json();
      lastBody = await res.text().catch(() => "");
      // Retry only transient server errors (the edge's 503s); client errors are terminal.
      if (res.status >= 500 && attempt < maxRetries) {
        await sleep(250 * (attempt + 1));
        continue;
      }
      throw new Error(`invesco: HTTP ${res.status} for ${url} — ${lastBody.slice(0, 200)}`);
    }
    // Unreachable (the loop returns or throws), but satisfies the type checker.
    throw new Error(`invesco: exhausted retries for ${url} — ${lastBody.slice(0, 200)}`);
  };

  return async (url: string): Promise<unknown> => {
    if (ttl > 0 && url.includes("/product/search")) {
      const t = now();
      if (!catalog || t - catalog.at >= ttl) {
        const value = rawGet(url);
        catalog = { at: t, value };
        // Evict a rejected fetch so the next call retries instead of caching the error.
        value.catch(() => {
          if (catalog && catalog.value === value) catalog = null;
        });
      }
      return catalog.value;
    }
    return rawGet(url);
  };
}
