// Cache + retry behavior of the real client's `get`. The client is otherwise verified live, but
// the 24 h catalog memoization and the 5xx retry are pure logic, so they're unit-tested here with
// an injected fetch (call-counting), an injected clock, and an injected (instant) sleep. No network.

import { test, expect } from "bun:test";
import { makeInvescoGet } from "../src/client.js";
import { SEARCH_URL, holdingsUrl } from "../src/invesco.js";

/** A fake fetch that counts calls and returns a canned JSON body. */
function countingFetch(body: unknown = { ok: 1 }) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => body, text: async () => "" } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

const HOLDINGS_URL = holdingsUrl("46137V357");
const noSleep = () => Promise.resolve();

test("catalog is fetched once then served from cache within the TTL", async () => {
  const { impl, calls } = countingFetch();
  let clock = 1_000_000;
  const get = makeInvescoGet(impl, { now: () => clock, sleep: noSleep });
  await get(SEARCH_URL);
  await get(SEARCH_URL);
  clock += 60 * 60 * 1000; // +1 h, still within the 24 h TTL
  await get(SEARCH_URL);
  expect(calls.length).toBe(1);
});

test("catalog is refetched after the TTL expires", async () => {
  const { impl, calls } = countingFetch();
  let clock = 0;
  const get = makeInvescoGet(impl, { now: () => clock, sleep: noSleep });
  await get(SEARCH_URL);
  clock += 24 * 60 * 60 * 1000 + 1; // just past 24 h
  await get(SEARCH_URL);
  expect(calls.length).toBe(2);
});

test("non-catalog URLs are never cached", async () => {
  const { impl, calls } = countingFetch();
  const get = makeInvescoGet(impl, { sleep: noSleep });
  await get(HOLDINGS_URL);
  await get(HOLDINGS_URL);
  expect(calls.length).toBe(2);
});

test("concurrent first catalog requests coalesce into a single fetch", async () => {
  const { impl, calls } = countingFetch();
  const get = makeInvescoGet(impl, { sleep: noSleep });
  await Promise.all([get(SEARCH_URL), get(SEARCH_URL), get(SEARCH_URL)]);
  expect(calls.length).toBe(1);
});

test("catalogCacheMs: 0 disables caching", async () => {
  const { impl, calls } = countingFetch();
  const get = makeInvescoGet(impl, { catalogCacheMs: 0, sleep: noSleep });
  await get(SEARCH_URL);
  await get(SEARCH_URL);
  expect(calls.length).toBe(2);
});

test("a transient 503 is retried and then succeeds", async () => {
  const calls: string[] = [];
  let fails = 2; // first two attempts 503, then 200
  const impl = (async (url: string) => {
    calls.push(url);
    if (fails-- > 0) {
      return { ok: false, status: 503, json: async () => ({}), text: async () => "down" } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: 1 }), text: async () => "" } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  const get = makeInvescoGet(impl, { sleep: noSleep });
  const out = await get(HOLDINGS_URL);
  expect(out).toEqual({ ok: 1 });
  expect(calls.length).toBe(3);
});

test("a 4xx is terminal (not retried)", async () => {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    return { ok: false, status: 404, json: async () => ({}), text: async () => "nope" } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  const get = makeInvescoGet(impl, { sleep: noSleep });
  await expect(get(HOLDINGS_URL)).rejects.toThrow(/HTTP 404/);
  expect(calls.length).toBe(1);
});

test("a persistent 5xx throws after exhausting retries", async () => {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    return { ok: false, status: 503, json: async () => ({}), text: async () => "down" } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  const get = makeInvescoGet(impl, { sleep: noSleep, maxRetries: 2 });
  await expect(get(HOLDINGS_URL)).rejects.toThrow(/HTTP 503/);
  expect(calls.length).toBe(3); // 1 + 2 retries
});

test("a failed catalog fetch is evicted so the next call retries", async () => {
  const calls: string[] = [];
  let failNext = true;
  const impl = (async (url: string) => {
    calls.push(url);
    if (failNext) {
      failNext = false;
      return { ok: false, status: 404, json: async () => ({}), text: async () => "down" } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: 1 }), text: async () => "" } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  const get = makeInvescoGet(impl, { sleep: noSleep });
  await expect(get(SEARCH_URL)).rejects.toThrow(/HTTP 404/);
  const ok = await get(SEARCH_URL); // cache was evicted → retries and succeeds
  expect(ok).toEqual({ ok: 1 });
  expect(calls.length).toBe(2);
});
