// Arrow output schemas + row→batch mapping for the products/holdings tables and the three
// table functions.
//
// Invesco data has a STABLE, known shape, so we emit real typed columns (not a single JSON
// string): Utf8 identifiers/names, Float64 prices/weights/returns, Int64 counts, and a real Arrow
// DATE (Date32) for every calendar date. `batchFromColumns` defaults to the "rich" representation,
// so a DATE cell is a JS `Date` (at UTC midnight) and an Int64 cell is a bigint. Percent-valued
// columns carry a `_percent` suffix and hold percent-magnitude numbers (e.g. 7.38 = 7.38%),
// matching Invesco's raw values; ratios that are not percents (pe_ratio, pb_ratio) are NOT suffixed.

import { Schema, Field, Utf8, Float64, Int64, DateDay } from "@query-farm/apache-arrow";
import { batchFromColumns } from "@query-farm/vgi";
import type {
  ProductRow,
  HoldingRow,
  FundDetailsRow,
  DistributionRow,
  NavHistoryRow,
} from "./invesco.js";

const f = (name: string, type: ConstructorParameters<typeof Field>[1]) => new Field(name, type, true);
const date = () => new DateDay();

/**
 * A hive-style partition-column field: carries `vgi.partition_column = "true"` so the DuckDB
 * binder treats it as a partition key. `holdings` is partitioned on `fund_ticker` — each scanned
 * fund is one SINGLE_VALUE partition (see makeHoldingsScan). Mirrors vgi's `partition_field`.
 */
const partitionField = (name: string, type: ConstructorParameters<typeof Field>[1]) =>
  new Field(name, type, true, new Map([["vgi.partition_column", "true"]]));

/** Map an Arrow field type to the DuckDB type name shown in docs. */
function duckdbType(type: unknown): string {
  const n = (type as { constructor?: { name?: string } })?.constructor?.name ?? "";
  if (n.startsWith("Utf8")) return "VARCHAR";
  if (n.startsWith("Float")) return "DOUBLE";
  if (n.startsWith("Int") || n.startsWith("Uint")) return "BIGINT";
  if (n.startsWith("Date")) return "DATE";
  return "VARCHAR";
}

/**
 * Build the `vgi.result_columns_schema` tag value (a JSON array of {name, type, description})
 * for a static result schema, DRY from the Arrow schema + a name→description map.
 */
export function resultColumnsSchema(schema: Schema, descriptions: Record<string, string>): string {
  return JSON.stringify(
    schema.fields.map((field) => ({
      name: field.name,
      type: duckdbType(field.type),
      description: descriptions[field.name] ?? field.name,
    })),
  );
}

/** bigint | null for an Int64 cell from a JS number that may be null. */
const bigOrNull = (v: number | null): bigint | null => (v == null ? null : BigInt(Math.trunc(v)));

/** JS Date | null for a DATE (Date32) cell from epoch SECONDS at UTC midnight. */
const dateOrNull = (sec: number | null): Date | null => (sec == null ? null : new Date(sec * 1000));

// ── products ──────────────────────────────────────────────────────────────────

export function productsSchema(): Schema {
  return new Schema([
    f("ticker", new Utf8()),
    f("cusip", new Utf8()),
    f("isin", new Utf8()),
    f("sedol", new Utf8()),
    f("name", new Utf8()),
    f("asset_class", new Utf8()),
    f("asset_sub_class", new Utf8()),
    f("asset_sub_sub_class", new Utf8()),
    f("investment_method", new Utf8()),
    f("strategy", new Utf8()),
    f("umbrella", new Utf8()),
    f("distribution_frequency", new Utf8()),
    f("base_currency", new Utf8()),
    f("bloomberg_ticker", new Utf8()),
    f("region", new Utf8()),
    f("inception_date", date()),
    f("expense_ratio_percent", new Float64()),
    f("net_expense_ratio_percent", new Float64()),
    f("product_page_url", new Utf8()),
    f("factsheet_url", new Utf8()),
  ]);
}

export function productsBatch(schema: Schema, rows: ProductRow[]) {
  return batchFromColumns(
    {
      ticker: rows.map((r) => r.ticker),
      cusip: rows.map((r) => r.cusip),
      isin: rows.map((r) => r.isin),
      sedol: rows.map((r) => r.sedol),
      name: rows.map((r) => r.name),
      asset_class: rows.map((r) => r.asset_class),
      asset_sub_class: rows.map((r) => r.asset_sub_class),
      asset_sub_sub_class: rows.map((r) => r.asset_sub_sub_class),
      investment_method: rows.map((r) => r.investment_method),
      strategy: rows.map((r) => r.strategy),
      umbrella: rows.map((r) => r.umbrella),
      distribution_frequency: rows.map((r) => r.distribution_frequency),
      base_currency: rows.map((r) => r.base_currency),
      bloomberg_ticker: rows.map((r) => r.bloomberg_ticker),
      region: rows.map((r) => r.region),
      inception_date: rows.map((r) => dateOrNull(r.inception_date)),
      expense_ratio_percent: rows.map((r) => r.expense_ratio_percent),
      net_expense_ratio_percent: rows.map((r) => r.net_expense_ratio_percent),
      product_page_url: rows.map((r) => r.product_page_url),
      factsheet_url: rows.map((r) => r.factsheet_url),
    },
    schema,
  );
}

// ── holdings ────────────────────────────────────────────────────────────────

export function holdingsSchema(): Schema {
  return new Schema([
    // fund_ticker is the hive partition key: holdings_scan emits one SINGLE_VALUE partition per fund.
    partitionField("fund_ticker", new Utf8()),
    f("as_of_date", date()),
    f("name", new Utf8()),
    f("ticker", new Utf8()),
    f("cusip", new Utf8()),
    f("weight_percent", new Float64()),
    f("market_value", new Float64()),
    f("units", new Float64()),
    f("sec_type", new Utf8()),
    f("currency", new Utf8()),
    f("coupon_percent", new Float64()),
    f("maturity_date", date()),
    f("next_call_date", date()),
    f("rating", new Utf8()),
  ]);
}

export function holdingsBatch(schema: Schema, rows: HoldingRow[]) {
  return batchFromColumns(
    {
      fund_ticker: rows.map((r) => r.fundTicker),
      as_of_date: rows.map((r) => dateOrNull(r.asOfDate)),
      name: rows.map((r) => r.name),
      ticker: rows.map((r) => r.ticker),
      cusip: rows.map((r) => r.cusip),
      weight_percent: rows.map((r) => r.weightPercent),
      market_value: rows.map((r) => r.marketValue),
      units: rows.map((r) => r.units),
      sec_type: rows.map((r) => r.secType),
      currency: rows.map((r) => r.currency),
      coupon_percent: rows.map((r) => r.couponPercent),
      maturity_date: rows.map((r) => dateOrNull(r.maturityDate)),
      next_call_date: rows.map((r) => dateOrNull(r.nextCallDate)),
      rating: rows.map((r) => r.rating),
    },
    schema,
  );
}

// ── fund_details ──────────────────────────────────────────────────────────────

export function fundDetailsSchema(): Schema {
  return new Schema([
    f("ticker", new Utf8()),
    f("cusip", new Utf8()),
    f("isin", new Utf8()),
    f("name", new Utf8()),
    f("asset_class", new Utf8()),
    f("asset_sub_class", new Utf8()),
    f("investment_method", new Utf8()),
    f("strategy", new Utf8()),
    f("inception_date", date()),
    f("expense_ratio_percent", new Float64()),
    f("net_expense_ratio_percent", new Float64()),
    f("distribution_frequency", new Utf8()),
    f("net_assets", new Float64()),
    f("num_holdings", new Int64()),
    f("as_of_date", date()),
    f("nav", new Float64()),
    f("closing_price", new Float64()),
    f("shares_outstanding", new Int64()),
    f("premium_discount_percent", new Float64()),
    f("thirty_day_avg_volume", new Int64()),
    f("sec_yield_30day_percent", new Float64()),
    f("ytd_return_percent", new Float64()),
    f("pe_ratio", new Float64()),
    f("forward_pe_ratio", new Float64()),
    f("pb_ratio", new Float64()),
    f("return_on_equity_percent", new Float64()),
    f("weighted_avg_market_cap", new Float64()),
    f("return_1y_percent", new Float64()),
    f("return_3y_percent", new Float64()),
    f("return_5y_percent", new Float64()),
    f("return_10y_percent", new Float64()),
    f("return_since_inception_percent", new Float64()),
    f("primary_benchmark", new Utf8()),
    f("benchmark_return_1y_percent", new Float64()),
  ]);
}

export function fundDetailsBatch(schema: Schema, rows: FundDetailsRow[]) {
  return batchFromColumns(
    {
      ticker: rows.map((r) => r.ticker),
      cusip: rows.map((r) => r.cusip),
      isin: rows.map((r) => r.isin),
      name: rows.map((r) => r.name),
      asset_class: rows.map((r) => r.asset_class),
      asset_sub_class: rows.map((r) => r.asset_sub_class),
      investment_method: rows.map((r) => r.investment_method),
      strategy: rows.map((r) => r.strategy),
      inception_date: rows.map((r) => dateOrNull(r.inception_date)),
      expense_ratio_percent: rows.map((r) => r.expense_ratio_percent),
      net_expense_ratio_percent: rows.map((r) => r.net_expense_ratio_percent),
      distribution_frequency: rows.map((r) => r.distribution_frequency),
      net_assets: rows.map((r) => r.net_assets),
      num_holdings: rows.map((r) => bigOrNull(r.num_holdings)),
      as_of_date: rows.map((r) => dateOrNull(r.as_of_date)),
      nav: rows.map((r) => r.nav),
      closing_price: rows.map((r) => r.closing_price),
      shares_outstanding: rows.map((r) => bigOrNull(r.shares_outstanding)),
      premium_discount_percent: rows.map((r) => r.premium_discount_percent),
      thirty_day_avg_volume: rows.map((r) => bigOrNull(r.thirty_day_avg_volume)),
      sec_yield_30day_percent: rows.map((r) => r.sec_yield_30day_percent),
      ytd_return_percent: rows.map((r) => r.ytd_return_percent),
      pe_ratio: rows.map((r) => r.pe_ratio),
      forward_pe_ratio: rows.map((r) => r.forward_pe_ratio),
      pb_ratio: rows.map((r) => r.pb_ratio),
      return_on_equity_percent: rows.map((r) => r.return_on_equity_percent),
      weighted_avg_market_cap: rows.map((r) => r.weighted_avg_market_cap),
      return_1y_percent: rows.map((r) => r.return_1y_percent),
      return_3y_percent: rows.map((r) => r.return_3y_percent),
      return_5y_percent: rows.map((r) => r.return_5y_percent),
      return_10y_percent: rows.map((r) => r.return_10y_percent),
      return_since_inception_percent: rows.map((r) => r.return_since_inception_percent),
      primary_benchmark: rows.map((r) => r.primary_benchmark),
      benchmark_return_1y_percent: rows.map((r) => r.benchmark_return_1y_percent),
    },
    schema,
  );
}

// ── distributions ─────────────────────────────────────────────────────────────

export function distributionsSchema(): Schema {
  return new Schema([
    f("ex_date", date()),
    f("record_date", date()),
    f("pay_date", date()),
    f("amount_per_share", new Float64()),
    f("ordinary_income", new Float64()),
    f("short_term_capital_gain", new Float64()),
    f("long_term_capital_gain", new Float64()),
    f("return_of_capital", new Float64()),
  ]);
}

export function distributionsBatch(schema: Schema, rows: DistributionRow[]) {
  return batchFromColumns(
    {
      ex_date: rows.map((r) => dateOrNull(r.exDate)),
      record_date: rows.map((r) => dateOrNull(r.recordDate)),
      pay_date: rows.map((r) => dateOrNull(r.payDate)),
      amount_per_share: rows.map((r) => r.amountPerShare),
      ordinary_income: rows.map((r) => r.ordinaryIncome),
      short_term_capital_gain: rows.map((r) => r.shortTermCapitalGain),
      long_term_capital_gain: rows.map((r) => r.longTermCapitalGain),
      return_of_capital: rows.map((r) => r.returnOfCapital),
    },
    schema,
  );
}

// ── nav_history ───────────────────────────────────────────────────────────────

export function navHistorySchema(): Schema {
  return new Schema([f("as_of_date", date()), f("nav", new Float64())]);
}

export function navHistoryBatch(schema: Schema, rows: NavHistoryRow[]) {
  return batchFromColumns(
    {
      as_of_date: rows.map((r) => dateOrNull(r.asOfDate)),
      nav: rows.map((r) => r.nav),
    },
    schema,
  );
}
