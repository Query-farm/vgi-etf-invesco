// Archetype proof for invesco.products: the /product/search catalog driver + value coercion.
// Imports ONLY our own src + the fake — NO @query-farm/* — so it runs without the SDK installed.

import { test, expect } from "bun:test";
import {
  parseProducts,
  fetchProducts,
  num,
  str,
  dateSec,
  decodeEntities,
  SEARCH_URL,
} from "../src/invesco.js";
import { FakeInvesco, catalogEnvelope } from "./fake-invesco.js";

test("num strips $/,/% and parses string numbers, rejects blanks", () => {
  expect(num("0.2")).toBe(0.2);
  expect(num("12.03")).toBe(12.03);
  expect(num("-0.15")).toBe(-0.15);
  expect(num("1,182,200")).toBe(1182200);
  expect(num(203.66)).toBe(203.66);
  expect(num("")).toBeNull();
  expect(num("  ")).toBeNull();
  expect(num(null)).toBeNull();
});

test("str trims and nulls blanks", () => {
  expect(str("  RSP ")).toBe("RSP");
  expect(str("")).toBeNull();
  expect(str("   ")).toBeNull();
  expect(str(null)).toBeNull();
});

test("dateSec handles ISO (YYYY-MM-DD) and US (MM/DD/YYYY) shapes", () => {
  expect(dateSec("2026-07-07")).toBe(Math.floor(Date.UTC(2026, 6, 7) / 1000));
  expect(dateSec("2003-04-24")).toBe(Math.floor(Date.UTC(2003, 3, 24) / 1000));
  expect(dateSec("07/07/2026")).toBe(Math.floor(Date.UTC(2026, 6, 7) / 1000));
  expect(dateSec("1/2/2025")).toBe(Math.floor(Date.UTC(2025, 0, 2) / 1000));
  expect(dateSec("")).toBeNull();
  expect(dateSec("not a date")).toBeNull();
  expect(dateSec("2026-13-45")).toBeNull(); // impossible parts → null
});

test("decodeEntities unescapes the few HTML entities Invesco leaves in labels", () => {
  expect(decodeEntities("S&amp;P 500 Equal Weight Index")).toBe("S&P 500 Equal Weight Index");
  expect(decodeEntities(null)).toBeNull();
});

test("parseProducts maps an ETF doc with typed / date fields", () => {
  const rows = parseProducts(catalogEnvelope());
  expect(rows.length).toBe(2);
  const rsp = rows.find((r) => r.ticker === "RSP")!;
  expect(rsp.cusip).toBe("46137V357");
  expect(rsp.isin).toBe("US46137V3574");
  expect(rsp.name).toBe("Invesco S&P 500 Equal Weight ETF");
  expect(rsp.asset_class).toBe("Equity");
  expect(rsp.investment_method).toBe("Passive");
  expect(rsp.expense_ratio_percent).toBe(0.2);
  expect(rsp.net_expense_ratio_percent).toBe(0.2);
  expect(rsp.inception_date).toBe(Math.floor(Date.UTC(2003, 3, 24) / 1000));
  expect(rsp.distribution_frequency).toBe("Quarterly");
});

test("parseProducts classifies a fixed-income ETF", () => {
  const bscr = parseProducts(catalogEnvelope()).find((r) => r.ticker === "BSCR")!;
  expect(bscr.asset_class).toBe("Fixed Income");
  expect(bscr.asset_sub_class).toBe("Target Maturity");
  expect(bscr.cusip).toBe("46138J783");
});

test("parseProducts narrows to one ticker (case-insensitive)", () => {
  const one = parseProducts(catalogEnvelope(), "rsp");
  expect(one.length).toBe(1);
  expect(one[0]!.ticker).toBe("RSP");
  expect(parseProducts(catalogEnvelope(), "ZZZZ")).toEqual([]);
});

test("parseProducts tolerates junk without throwing", () => {
  expect(parseProducts(null)).toEqual([]);
  expect(parseProducts({ x: 1 })).toEqual([]);
  expect(parseProducts({ response: { docs: [] } })).toEqual([]);
});

test("fetchProducts hits the catalog URL once", async () => {
  const fake = new FakeInvesco(() => catalogEnvelope());
  const rows = await fetchProducts(fake.get);
  expect(rows.length).toBe(2);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).toBe(SEARCH_URL);
});
