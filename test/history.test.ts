// Archetype proof for the per-fund detail/history drivers: fund_details (catalog identity +
// keyStats + fundDetails + characteristics + prices + performance), distributions, and nav_history.
// SDK-free.

import { test, expect } from "bun:test";
import {
  parseFundDetails,
  parseDistributions,
  parseNavHistory,
  fetchFundDetails,
  fetchDistributions,
  fetchNavHistory,
  parseProducts,
} from "../src/invesco.js";
import {
  FakeInvesco,
  catalogEnvelope,
  keyStatsEnvelope,
  fundDetailsEnvelope,
  characteristicsEnvelope,
  pricesEnvelope,
  performanceEnvelope,
  distributionEnvelope,
  navsEnvelope,
} from "./fake-invesco.js";

const rspProduct = () => parseProducts(catalogEnvelope(), "RSP")[0]!;

test("parseFundDetails merges the catalog row + the four live envelopes into one row", () => {
  const row = parseFundDetails(
    rspProduct(),
    keyStatsEnvelope(),
    fundDetailsEnvelope(),
    characteristicsEnvelope(),
    pricesEnvelope(),
    performanceEnvelope(),
  );
  // identity from catalog
  expect(row.ticker).toBe("RSP");
  expect(row.cusip).toBe("46137V357");
  expect(row.expense_ratio_percent).toBe(0.2);
  // fundDetails variation
  expect(row.net_assets).toBe(90125734054.26);
  expect(row.num_holdings).toBe(505);
  // keyStats
  expect(row.sec_yield_30day_percent).toBe(1.515612);
  expect(row.ytd_return_percent).toBe(12.033712);
  // characteristics (ratios not suffixed; ROE is a percent)
  expect(row.pe_ratio).toBe(21.067522);
  expect(row.forward_pe_ratio).toBe(16.902337);
  expect(row.pb_ratio).toBe(3.338811);
  expect(row.return_on_equity_percent).toBe(18.547836);
  // prices
  expect(row.nav).toBe(203.677982);
  expect(row.closing_price).toBe(203.66);
  expect(row.shares_outstanding).toBe(428892663);
  expect(row.premium_discount_percent).toBe(0.005901);
  expect(row.thirty_day_avg_volume).toBe(8859930);
  // performance (fund + benchmark, entity-decoded)
  expect(row.return_1y_percent).toBe(20.22848);
  expect(row.return_10y_percent).toBe(11.857879);
  expect(row.primary_benchmark).toBe("S&P 500 Equal Weight Index");
  expect(row.benchmark_return_1y_percent).toBe(20.431386);
});

test("parseFundDetails degrades to nulls on empty envelopes", () => {
  const row = parseFundDetails(null, {}, {}, {}, {}, {});
  expect(row.ticker).toBeNull();
  expect(row.nav).toBeNull();
  expect(row.pe_ratio).toBeNull();
  expect(row.primary_benchmark).toBeNull();
});

test("parseDistributions maps items with the component breakdown", () => {
  const rows = parseDistributions(distributionEnvelope());
  expect(rows.length).toBe(2);
  const d0 = rows[0]!;
  expect(d0.amountPerShare).toBe(0.81014);
  expect(d0.ordinaryIncome).toBe(0.81014);
  expect(d0.exDate).toBe(Math.floor(Date.UTC(2026, 5, 22) / 1000));
  expect(d0.payDate).toBe(Math.floor(Date.UTC(2026, 5, 26) / 1000));
});

test("parseDistributions bounds rows by ex date [start, end]", () => {
  const start = Math.floor(Date.UTC(2026, 3, 1) / 1000); // Apr 1 2026 → drops the Mar 23 row
  const rows = parseDistributions(distributionEnvelope(), start, null);
  expect(rows.length).toBe(1);
  expect(rows[0]!.exDate).toBe(Math.floor(Date.UTC(2026, 5, 22) / 1000));
});

test("parseNavHistory maps the NAV line chart (MM/DD/YYYY dates)", () => {
  const rows = parseNavHistory(navsEnvelope());
  expect(rows.length).toBe(3);
  const r0 = rows[0]!;
  expect(r0.asOfDate).toBe(Math.floor(Date.UTC(2026, 6, 7) / 1000));
  expect(r0.nav).toBe(214.742261);
});

test("parseNavHistory bounds rows by date [start, end]", () => {
  const start = Math.floor(Date.UTC(2026, 0, 1) / 1000); // drops the Jan 2025 point
  const rows = parseNavHistory(navsEnvelope(), start, null);
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.asOfDate! >= start)).toBe(true);
});

test("parseNavHistory returns [] for an empty envelope, no throw", () => {
  expect(parseNavHistory({})).toEqual([]);
  expect(parseNavHistory({ lineChartData: [] })).toEqual([]);
});

test("fetchFundDetails requests the five per-fund resources for the CUSIP", async () => {
  const fake = FakeInvesco.router({
    keyStats: keyStatsEnvelope(),
    fundDetails: fundDetailsEnvelope(),
    characteristics: characteristicsEnvelope(),
    prices: pricesEnvelope(),
    performance: performanceEnvelope(),
  });
  const row = await fetchFundDetails(fake.get, rspProduct());
  expect(row.nav).toBe(203.677982);
  expect(fake.calls.length).toBe(5);
  expect(fake.calls.every((u) => u.includes("46137V357"))).toBe(true);
  expect(fake.calls.some((u) => u.includes("/keyStats"))).toBe(true);
  expect(fake.calls.some((u) => u.includes("variationType=fundDetails"))).toBe(true);
  expect(fake.calls.some((u) => u.includes("variationType=fundCharacteristics"))).toBe(true);
  expect(fake.calls.some((u) => u.includes("/prices"))).toBe(true);
  expect(fake.calls.some((u) => u.includes("/performance/standard"))).toBe(true);
});

test("fetchDistributions reads the distribution resource", async () => {
  const fake = FakeInvesco.router({ distribution: distributionEnvelope() });
  const rows = await fetchDistributions(fake.get, "46137V357");
  expect(rows.length).toBe(2);
  expect(fake.calls[0]).toContain("/distribution");
});

test("fetchNavHistory hits the navs resource", async () => {
  const fake = FakeInvesco.router({ navs: navsEnvelope() });
  const rows = await fetchNavHistory(fake.get, "46137V357");
  expect(rows.length).toBe(3);
  expect(fake.calls[0]).toContain("/navs");
});
