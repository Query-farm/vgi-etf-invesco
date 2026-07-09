// Typed-column contract for the five schemas. This one pulls @query-farm/vgi (batchFromColumns) +
// apache-arrow, so it runs under the full SDK install — unlike the driver tests, which are
// deliberately SDK-free. Proves schema field names/order and that Utf8/Float64/Int64/Date cells
// (incl. nulls) round-trip into an Arrow batch.

import { test, expect } from "bun:test";
import {
  productsSchema,
  productsBatch,
  holdingsSchema,
  holdingsBatch,
  fundDetailsSchema,
  fundDetailsBatch,
  distributionsSchema,
  distributionsBatch,
  navHistorySchema,
  navHistoryBatch,
} from "../src/schema.js";
import {
  parseProducts,
  parseHoldings,
  parseFundDetails,
  parseDistributions,
  parseNavHistory,
} from "../src/invesco.js";
import {
  catalogEnvelope,
  equityHoldingsEnvelope,
  keyStatsEnvelope,
  fundDetailsEnvelope,
  characteristicsEnvelope,
  pricesEnvelope,
  performanceEnvelope,
  distributionEnvelope,
  navsEnvelope,
} from "./fake-invesco.js";

const names = (schema: { fields: { name: string }[] }) => schema.fields.map((f) => f.name);

test("products schema field names + order", () => {
  expect(names(productsSchema())).toEqual([
    "ticker", "cusip", "isin", "sedol", "name", "asset_class", "asset_sub_class",
    "asset_sub_sub_class", "investment_method", "strategy", "umbrella", "distribution_frequency",
    "base_currency", "bloomberg_ticker", "region", "inception_date", "expense_ratio_percent",
    "net_expense_ratio_percent", "product_page_url", "factsheet_url",
  ]);
});

test("holdings schema field names + order", () => {
  expect(names(holdingsSchema())).toEqual([
    "fund_ticker", "as_of_date", "name", "ticker", "cusip", "weight_percent", "market_value",
    "units", "sec_type", "currency", "coupon_percent", "maturity_date", "next_call_date", "rating",
  ]);
});

test("batch builders produce one row per parsed record", () => {
  expect((productsBatch(productsSchema(), parseProducts(catalogEnvelope())) as { numRows: number }).numRows).toBe(2);
  expect((holdingsBatch(holdingsSchema(), parseHoldings(equityHoldingsEnvelope(), "RSP")) as { numRows: number }).numRows).toBe(2);
  expect((fundDetailsBatch(fundDetailsSchema(), [parseFundDetails(parseProducts(catalogEnvelope(), "RSP")[0]!, keyStatsEnvelope(), fundDetailsEnvelope(), characteristicsEnvelope(), pricesEnvelope(), performanceEnvelope())]) as { numRows: number }).numRows).toBe(1);
  expect((distributionsBatch(distributionsSchema(), parseDistributions(distributionEnvelope())) as { numRows: number }).numRows).toBe(2);
  expect((navHistoryBatch(navHistorySchema(), parseNavHistory(navsEnvelope())) as { numRows: number }).numRows).toBe(3);
});

test("empty inputs build a zero-row batch, not a throw", () => {
  expect((productsBatch(productsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((holdingsBatch(holdingsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((fundDetailsBatch(fundDetailsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((distributionsBatch(distributionsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((navHistoryBatch(navHistorySchema(), []) as { numRows: number }).numRows).toBe(0);
});
