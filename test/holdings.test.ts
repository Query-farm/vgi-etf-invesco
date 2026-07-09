// Archetype proof for invesco.holdings: the /holdings/fund driver + fund resolution + DATE-arg
// conversion. SDK-free.

import { test, expect } from "bun:test";
import {
  parseHoldings,
  fetchHoldings,
  resolveFund,
  dateArgToEpoch,
  holdingsUrl,
  shareclassUrl,
} from "../src/invesco.js";
import {
  FakeInvesco,
  catalogEnvelope,
  equityHoldingsEnvelope,
  bondHoldingsEnvelope,
} from "./fake-invesco.js";

test("shareclassUrl / holdingsUrl carry the CUSIP and idType=cusip", () => {
  const u = shareclassUrl("46137V357", "/keyStats");
  expect(u).toContain("/shareclasses/46137V357/keyStats");
  expect(u).toContain("idType=cusip");
  expect(u).toContain("productType=ETF");
  expect(holdingsUrl("46137V357")).toContain("/shareclasses/46137V357/holdings/fund");
});

test("dateArgToEpoch returns epoch seconds at UTC midnight (from epoch-ms), null when absent", () => {
  expect(dateArgToEpoch(Date.UTC(2025, 0, 1))).toBe(Math.floor(Date.UTC(2025, 0, 1) / 1000));
  expect(dateArgToEpoch(new Date(Date.UTC(2025, 0, 1)))).toBe(Math.floor(Date.UTC(2025, 0, 1) / 1000));
  expect(dateArgToEpoch(Math.floor(Date.UTC(2025, 0, 1) / 86400000))).toBe(Math.floor(Date.UTC(2025, 0, 1) / 1000));
  expect(dateArgToEpoch("2025-01-01")).toBe(Math.floor(Date.UTC(2025, 0, 1) / 1000));
  expect(dateArgToEpoch(null)).toBeNull();
});

test("parseHoldings maps equity constituents, tolerates blank cells, tags the fund + as-of", () => {
  const rows = parseHoldings(equityHoldingsEnvelope(), "RSP");
  expect(rows.length).toBe(2);
  const mrna = rows[0]!;
  expect(mrna.fundTicker).toBe("RSP");
  expect(mrna.ticker).toBe("MRNA");
  expect(mrna.name).toBe("Moderna Inc");
  expect(mrna.weightPercent).toBe(0.333568);
  expect(mrna.marketValue).toBe(323372982.09);
  expect(mrna.units).toBe(4053817);
  expect(mrna.secType).toBe("Common Stock");
  expect(mrna.asOfDate).toBe(Math.floor(Date.UTC(2026, 6, 7) / 1000));
  // equity holdings leave the bond-only columns null
  expect(mrna.couponPercent).toBeNull();
  expect(mrna.maturityDate).toBeNull();
  expect(rows[1]!.cusip).toBeNull(); // blank cell
});

test("parseHoldings sorts by weight descending (NULLS last)", () => {
  const rows = parseHoldings(equityHoldingsEnvelope(), "RSP");
  expect(rows.map((r) => r.ticker)).toEqual(["MRNA", "AAPL"]);
  expect(rows[0]!.weightPercent!).toBeGreaterThanOrEqual(rows[1]!.weightPercent!);
});

test("parseHoldings fills coupon / maturity / call / rating for bond funds", () => {
  const rows = parseHoldings(bondHoldingsEnvelope(), "BSCR");
  expect(rows.length).toBe(2);
  const b0 = rows[0]!;
  expect(b0.couponPercent).toBe(3.3);
  expect(b0.maturityDate).toBe(Math.floor(Date.UTC(2027, 1, 6) / 1000));
  expect(b0.nextCallDate).toBe(Math.floor(Date.UTC(2026, 10, 6) / 1000));
  expect(b0.rating).toBe("AAA/Aaa");
  expect(b0.secType).toBe("Corporate Bond");
});

test("parseHoldings returns [] for an empty/unknown envelope, no throw", () => {
  expect(parseHoldings({}, "RSP")).toEqual([]);
  expect(parseHoldings({ holdings: [] }, "RSP")).toEqual([]);
});

test("resolveFund maps a ticker via the catalog to its product row (CUSIP + identity)", async () => {
  const fake = new FakeInvesco(() => catalogEnvelope());
  const row = await resolveFund(fake.get, "rsp");
  expect(row?.ticker).toBe("RSP");
  expect(row?.cusip).toBe("46137V357");
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).toContain("/product/search");
});

test("resolveFund also accepts a raw CUSIP", async () => {
  const fake = new FakeInvesco(() => catalogEnvelope());
  const row = await resolveFund(fake.get, "46138J783");
  expect(row?.ticker).toBe("BSCR");
});

test("resolveFund returns null on an unknown fund (caller raises the typed error)", async () => {
  const fake = new FakeInvesco(() => catalogEnvelope());
  expect(await resolveFund(fake.get, "ZZZZ")).toBeNull();
});

test("fetchHoldings hits the holdings resource for the fund's CUSIP", async () => {
  const fake = FakeInvesco.router({ holdings: equityHoldingsEnvelope() });
  const rows = await fetchHoldings(fake.get, "46137V357", "RSP");
  expect(rows.length).toBe(2);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).toContain("/shareclasses/46137V357/holdings/fund");
});
