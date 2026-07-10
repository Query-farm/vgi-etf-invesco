// The VGI table functions and base-table backing scans: the `products` and `holdings` tables
// (backing scans) plus three callable functions — fund_details, distributions, nav_history. All
// keyless, all single-shot snapshots — function state is just a `done` flag (fully serializable;
// no socket / batch / Date), so the HTTP transport can round-trip it. The Invesco `get` client is
// injected so worker.ts wires the real fetch and tests wire a fake.
//
// NOTE — Invesco holdings are CURRENT-only: the holdings scan is hive-partitioned by fund_ticker
// but declares NO time travel (each fund reports one effectiveDate; `as_of_date` is an output
// column).

import {
  defineTableFunction,
  ArgumentValidationError,
  batchFromColumns,
  serializeBatch,
  deserializeFilters,
  buildJoinKeysLookup,
  DEFAULT_MAX_WORKERS,
  type OutputCollector,
} from "@query-farm/vgi";
import { Schema, Field, Utf8, DateDay } from "@query-farm/apache-arrow";
import {
  fetchProducts,
  fetchHoldings,
  fetchFundDetails,
  fetchDistributions,
  fetchNavHistory,
  resolveFund,
  dateArgToEpoch,
  type ProductRow,
} from "./invesco.js";
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
  resultColumnsSchema,
} from "./schema.js";

/** The injected HTTP getter: URL in, parsed JSON out. */
export type InvescoGet = (url: string) => Promise<unknown>;

// Per-column descriptions for the `vgi.result_columns_schema` tag (JSON [{name,type,description}],
// generated from each Arrow schema via resultColumnsSchema).

const HOLDINGS_SCAN_DESCS: Record<string, string> = {
  fund_ticker: "The fund's ticker — the partition filter (e.g. RSP).",
  as_of_date: "The effective date Invesco reports for these holdings.",
  name: "Constituent / issuer name.",
  ticker: "Constituent ticker (the holding's own ticker; distinct from fund_ticker).",
  cusip: "Constituent CUSIP.",
  weight_percent: "Percent of the fund, 0–100 (0.33 = 0.33%).",
  market_value: "Market value held, in the fund's base currency.",
  units: "Quantity held, as a count of shares/units (or par for bonds).",
  sec_type: "Security type classification (e.g. Common Stock, Corporate Bond).",
  currency: "Currency of the position.",
  coupon_percent: "Coupon rate, percent points (fixed income only).",
  maturity_date: "Maturity date (fixed income only).",
  next_call_date: "Next call date (fixed income only).",
  rating: "S&P / Moody's rating (fixed income only).",
};

const FUND_DETAILS_DESCS: Record<string, string> = {
  ticker: "Exchange ticker.",
  cusip: "Fund CUSIP.",
  isin: "Fund ISIN.",
  name: "Fund name.",
  asset_class: "Asset class (Equity, Fixed Income, Alternative, …).",
  asset_sub_class: "Asset sub-class (e.g. U.S. Equity).",
  investment_method: "Passive or Active.",
  strategy: "Invesco strategy label / tracked index.",
  inception_date: "Fund inception date.",
  expense_ratio_percent: "Total expense ratio, percent points (0.2 = 0.20%).",
  net_expense_ratio_percent: "Net expense ratio, percent points.",
  distribution_frequency: "How often the fund distributes (e.g. Quarterly).",
  net_assets: "Total net assets of the share class, in USD.",
  num_holdings: "Number of holdings.",
  as_of_date: "As-of date for the net-assets / holdings-count snapshot.",
  nav: "Latest net asset value per share.",
  closing_price: "Latest market closing price per share.",
  shares_outstanding: "Shares outstanding.",
  premium_discount_percent: "Bid/ask midpoint premium or discount to NAV, percent points.",
  thirty_day_avg_volume: "30-day average trading volume, in shares.",
  sec_yield_30day_percent: "30-day SEC yield, percent points.",
  ytd_return_percent: "Year-to-date NAV return, percent points.",
  pe_ratio: "Price/earnings ratio (a ratio, not a percent).",
  forward_pe_ratio: "Forward price/earnings ratio (a ratio, not a percent).",
  pb_ratio: "Price/book ratio (a ratio, not a percent).",
  return_on_equity_percent: "Weighted return on equity, percent points.",
  weighted_avg_market_cap: "Weighted-average market capitalization, in USD.",
  return_1y_percent: "Annualized 1-year NAV return, percent points.",
  return_3y_percent: "Annualized 3-year NAV return, percent points.",
  return_5y_percent: "Annualized 5-year NAV return, percent points.",
  return_10y_percent: "Annualized 10-year NAV return, percent points.",
  return_since_inception_percent: "Annualized since-inception NAV return, percent points.",
  primary_benchmark: "Primary benchmark name.",
  benchmark_return_1y_percent: "Benchmark annualized 1-year return, percent points.",
};

const DISTRIBUTIONS_DESCS: Record<string, string> = {
  ex_date: "Ex-dividend date.",
  record_date: "Record date.",
  pay_date: "Payable date.",
  amount_per_share: "Total distribution per share, in USD.",
  ordinary_income: "Ordinary income component, per share.",
  short_term_capital_gain: "Short-term capital-gain component, per share.",
  long_term_capital_gain: "Long-term capital-gain component, per share.",
  return_of_capital: "Return-of-capital component, per share.",
};

const NAV_HISTORY_DESCS: Record<string, string> = {
  as_of_date: "Valuation date.",
  nav: "Net asset value per share.",
};

interface DoneState {
  done: boolean;
}

/** Guard a required string argument; returns the trimmed value or throws ArgumentValidationError. */
function required(fn: string, name: string, v: unknown): string {
  if (v == null || String(v).trim() === "") {
    throw new ArgumentValidationError(`${fn}: ${name} is required`);
  }
  return String(v).trim();
}

/** Resolve a `fund` arg to its catalog row, raising a typed, discoverable error when it misses. */
async function resolveOrThrow(fn: string, get: InvescoGet, fund: string): Promise<ProductRow> {
  const row = await resolveFund(get, fund);
  if (row == null || !row.cusip) {
    throw new ArgumentValidationError(
      `${fn}: could not resolve fund '${fund}'. Pass an Invesco ETF ticker (e.g. 'RSP'); ` +
        `list valid tickers with SELECT ticker FROM invesco.main.products.`,
    );
  }
  return row;
}

// ── holdings queue plumbing (BoundStorage work queue + hive partition metadata) ──
//
// The holdings scan streams one fund per partition. `onInit` seeds a BoundStorage queue with the
// target funds (one item each); each `process()` tick pops a fund, fetches its holdings, and emits
// one SINGLE_VALUE partition. Multiple parallel workers drain the same execution-scoped queue, so
// the fan-out is naturally work-stealing and bounded by maxWorkers.

/** A queued fund: its ticker (the partition value) and its CUSIP (the resource key). */
interface FundItem {
  ticker: string;
  cusip: string;
}
const encodeFund = (item: FundItem): Uint8Array => new TextEncoder().encode(JSON.stringify(item));
const decodeFund = (bytes: Uint8Array): FundItem => JSON.parse(new TextDecoder().decode(bytes));

/** Plain (non-annotated) field used to build the partition-values (min,max) batch. */
const FUND_TICKER_FIELD = new Field("fund_ticker", new Utf8(), true);

const b64encode = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/**
 * Build the `vgi_partition_values#b64` batch metadata for a SINGLE_VALUE partition: a 2-row
 * (min,max) Arrow batch over fund_ticker where min == max == the fund's ticker.
 */
function partitionValues(ticker: string): Map<string, string> {
  const batch = batchFromColumns({ fund_ticker: [ticker, ticker] }, new Schema([FUND_TICKER_FIELD]));
  return new Map([["vgi_partition_values#b64", b64encode(serializeBatch(batch))]]);
}

// ── products (backing scan for the products TABLE) ──────────────────────────────
//
// `products` is exposed as a real base TABLE (see catalog.ts `tables`), not a table function, so
// users query `FROM invesco.products` (no parens) and filter with WHERE — no arguments. This
// zero-arg scan is registered only for scan dispatch (it is NOT listed among the catalog's
// callable functions). It returns the Invesco ETF catalog; a WHERE on ticker / asset_class
// narrows it.

export function makeProductsScan(get: InvescoGet) {
  const schema = productsSchema();
  return defineTableFunction<Record<string, never>, DoneState>({
    name: "products",
    description: "Invesco US ETF catalog — backing scan for the products table.",
    args: {},
    onBind: () => ({ outputSchema: schema }),
    initialState: () => ({ done: false }),
    process: async (_p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const rows = await fetchProducts(get);
      out.emit(productsBatch(schema, rows));
      state.done = true;
    },
  });
}

// ── holdings (backing scan for the holdings TABLE) ─────────────────────────────
//
// `holdings` is exposed as a base TABLE (see catalog.ts), HIVE-PARTITIONED on `fund_ticker` (the
// fund's ticker — distinct from the constituent `ticker` column). Invesco holdings are
// CURRENT-only, so there is NO time travel:
//   SELECT * FROM invesco.main.holdings WHERE fund_ticker = 'RSP';
//   SELECT * FROM invesco.main.holdings WHERE fund_ticker IN ('RSP','SPHQ');  -- fan-out per partition
//   SELECT * FROM invesco.main.holdings;                                       -- ALL funds (every partition)
//
// Each fund is one SINGLE_VALUE partition. The scan is a streaming, queue-backed generator:
//   • onInit (runs once on the coordinator) reads the pushed fund_ticker filter — or, absent one,
//     the ENTIRE ETF catalog — resolves each ticker to its CUSIP and pushes one item per fund onto
//     a BoundStorage work queue keyed by the execution id.
//   • process() pops one fund per tick, fetches its current holdings (by CUSIP), and emits a single
//     partition batch (tagged with vgi_partition_values so DuckDB sees fund_ticker as the key). A
//     fund whose holdings resource errors (404/5xx) is skipped, not fatal.
// Multiple parallel workers drain the same queue, so the all-funds fan-out is work-stealing and
// bounded by maxWorkers. filterPushdown + being LISTED is what lets DuckDB push fund_ticker here.

export function makeHoldingsScan(get: InvescoGet) {
  const schema = holdingsSchema();
  return defineTableFunction<Record<string, never>, Record<string, never>>({
    // Named to MATCH the `holdings` table it backs (not "holdings_scan"): a table function and a
    // table can share a qualified name in DuckDB (the function is called with parens, the table
    // without), and naming them alike is what lets the metadata linter see this listed, parameterless
    // scan as the browsable `holdings` table rather than an orphan zero-arg function (VGI311).
    name: "holdings",
    description:
      "Backing scan for the holdings table — prefer the `holdings` table. Detailed current fund " +
      "holdings, hive-partitioned by fund_ticker: filter WHERE fund_ticker = 'RSP' (or " +
      "fund_ticker IN (…)) for specific funds, or scan with no filter to stream every fund's " +
      "holdings. weight_percent is in percent points; bond funds also fill coupon/maturity/rating.",
    args: {},
    // filterPushdown MUST be declared AND this function MUST be listed in the catalog so the DuckDB
    // extension can discover the capability and push the fund_ticker filter into the scan. Each
    // fund is one SINGLE_VALUE partition (fund_ticker is the hive partition key).
    filterPushdown: true,
    partitionKind: "SINGLE_VALUE_PARTITIONS",
    maxWorkers: DEFAULT_MAX_WORKERS,
    onBind: () => ({ outputSchema: schema }),
    // Seed the work queue (once, on the coordinator): one item per target fund.
    onInit: async ({ initCall, executionId, storage }) => {
      // Pushed fund_ticker value(s) from WHERE (= or IN), if any. Absent → scan all funds.
      const joinKeys = buildJoinKeysLookup(initCall.join_keys);
      const filters = initCall.pushdown_filters
        ? deserializeFilters(initCall.pushdown_filters, joinKeys)
        : undefined;
      const requested = (filters?.getColumnValues("fund_ticker") ?? []).map((t) =>
        String(t).toUpperCase(),
      );
      // Build the fund set from the (cached) ETF catalog. One fetch either way.
      const products = await fetchProducts(get);
      const byTicker = new Map<string, FundItem>(
        products
          .filter((r) => r.ticker && r.cusip)
          .map((r) => [
            String(r.ticker).toUpperCase(),
            { ticker: String(r.ticker).toUpperCase(), cusip: String(r.cusip) },
          ]),
      );
      const targets: FundItem[] =
        requested.length > 0
          ? requested.map((t) => byTicker.get(t)).filter((x): x is FundItem => x != null)
          : [...byTicker.values()];
      await storage.queuePush(targets.map(encodeFund));
      return { max_workers: DEFAULT_MAX_WORKERS, execution_id: executionId, opaque_data: null };
    },
    initialState: () => ({}),
    process: async (p, _state, out: OutputCollector) => {
      // Pop one fund per tick; emit exactly one partition. Skip empty/erroring partitions and pop
      // the next. Queue empty → end of scan.
      for (;;) {
        const item = await p.storage!.queuePop();
        if (item === null) {
          out.finish();
          return;
        }
        const fund = decodeFund(item);
        let rows;
        try {
          rows = await fetchHoldings(get, fund.cusip, fund.ticker);
        } catch {
          // A fund whose holdings resource 404s / 5xxs is skipped, not fatal (all-funds scans).
          continue;
        }
        if (rows.length === 0) continue;
        out.emit(holdingsBatch(schema, rows), partitionValues(fund.ticker));
        return;
      }
    },
    examples: [
      { sql: "SELECT ticker, name, weight_percent FROM invesco.main.holdings() WHERE fund_ticker = 'RSP' ORDER BY weight_percent DESC LIMIT 10", description: "Top 10 holdings of RSP via the backing scan" },
      { sql: "SELECT fund_ticker, count(*) FROM invesco.main.holdings() WHERE fund_ticker IN ('RSP', 'SPHQ') GROUP BY fund_ticker", description: "Two partitions at once (fan-out)" },
    ],
    tags: {
      "vgi.category": "holdings",
      "vgi.doc_llm":
        "The backing scan for the `holdings` table. Prefer querying the `holdings` table. " +
        "Hive-partitioned by fund_ticker (the fund's ticker, distinct from the constituent " +
        "`ticker` column): filter WHERE fund_ticker = '…' (or fund_ticker IN (…)) for specific " +
        "funds, or scan with no filter to stream every fund (a couple hundred partitions — slow). " +
        "Holdings are current-only (no historical as-of). weight_percent is in percent points " +
        "(0.33 = 0.33%); bond funds also fill coupon/maturity/rating.",
      "vgi.doc_md":
        "## holdings() backing scan\n\n" +
        "The backing scan for the **`holdings` table** — prefer the table. Hive-partitioned by " +
        "`fund_ticker`: filter `WHERE fund_ticker = 'RSP'` for one fund, or scan with no filter to " +
        "stream every fund (see the example queries). `fund_ticker` is distinct from the " +
        "constituent `ticker` column. Holdings are current-only (no historical as-of).",
      "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_SCAN_DESCS),
    },
  });
}

// ── fund_details ──────────────────────────────────────────────────────────────

interface FundArgs {
  fund: string;
}

const FUND_ARG_DOC =
  "The fund to look up, given as an exchange " +
  "ticker like 'RSP' (a raw CUSIP also works). Required, first positional argument.";

export function makeFundDetailsFunction(get: InvescoGet) {
  const schema = fundDetailsSchema();
  return defineTableFunction<FundArgs, DoneState>({
    name: "fund_details",
    description:
      "A wide one-row snapshot of a single fund's key facts and characteristics: identifiers, " +
      "expense ratio, net assets, NAV and closing price, premium/discount, 30-day SEC yield, " +
      "valuation ratios (P/E, forward P/E, P/B, ROE), annualized returns, and the primary " +
      "benchmark with its return. `fund` is a ticker like RSP.",
    args: { fund: new Utf8() },
    argDocs: { fund: FUND_ARG_DOC },
    onBind: (p) => {
      required("fund_details", "fund", p.args.fund);
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const product = await resolveOrThrow("fund_details", get, String(p.args.fund));
      const row = await fetchFundDetails(get, product);
      out.emit(fundDetailsBatch(schema, [row]));
      state.done = true;
    },
    examples: [
      { sql: "SELECT ticker, primary_benchmark, pe_ratio, expense_ratio_percent FROM invesco.main.fund_details('RSP')", description: "Key characteristics for RSP" },
      { sql: "SELECT ticker, net_assets, num_holdings, sec_yield_30day_percent FROM invesco.main.fund_details('RSP')", description: "Size, holdings count, and 30-day SEC yield" },
      { sql: "SELECT return_1y_percent, benchmark_return_1y_percent FROM invesco.main.fund_details('RSP')", description: "1-year fund return vs its benchmark" },
    ],
    tags: {
      "vgi.category": "catalog",
      "vgi.doc_llm":
        "One-row detail snapshot for a fund: identifiers, expense ratio, net assets, holdings " +
        "count, latest NAV/closing price, premium/discount, 30-day SEC yield, valuation ratios " +
        "(P/E, forward P/E, P/B, return on equity, weighted-average market cap), annualized " +
        "returns (1y/3y/5y/10y/since inception), and the primary benchmark and its 1-year return. " +
        "Percent columns are in percent points; pe_ratio / forward_pe_ratio / pb_ratio are ratios " +
        "(not percents). Deeper than the products row for a single fund.",
      "vgi.doc_md":
        "## fund_details\n\n" +
        "A wide one-row snapshot of a fund's key facts and characteristics — the details beyond what " +
        "`products` carries (net assets, holdings count, premium/discount, valuation ratios, " +
        "benchmark comparison). Percent columns are in percent points; `pe_ratio`, " +
        "`forward_pe_ratio`, and `pb_ratio` are ratios.\n\n" +
        "It returns exactly one row; for the whole lineup use `products` (see the example queries).",
      "vgi.result_columns_schema": resultColumnsSchema(fundDetailsSchema(), FUND_DETAILS_DESCS),
    },
  });
}

// ── distributions ─────────────────────────────────────────────────────────────

interface DistributionArgs {
  fund: string;
  start_date: Date | null;
  end_date: Date | null;
}

const RANGE_DOCS = {
  start_date:
    "Optional inclusive lower bound on the ex-day range — omit for no lower bound. Filters " +
    "client-side.",
  end_date:
    "Optional inclusive upper bound on the ex-day range — omit for no upper bound. Named " +
    "end_date because END is a reserved SQL keyword.",
};

export function makeDistributionsFunction(get: InvescoGet) {
  const schema = distributionsSchema();
  return defineTableFunction<DistributionArgs, DoneState>({
    name: "distributions",
    description:
      "Distribution history for a fund — one row per distribution with ex, record, and payable " +
      "dates, the total per-share amount, and its ordinary-income / capital-gain / " +
      "return-of-capital components. `fund` is a ticker; bound the ex-date range with " +
      "start_date/end_date.",
    args: { fund: new Utf8(), start_date: new DateDay(), end_date: new DateDay() },
    argDefaults: { start_date: null, end_date: null },
    argDocs: { fund: FUND_ARG_DOC, ...RANGE_DOCS },
    onBind: (p) => {
      required("distributions", "fund", p.args.fund);
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const product = await resolveOrThrow("distributions", get, String(p.args.fund));
      const rows = await fetchDistributions(
        get,
        String(product.cusip),
        dateArgToEpoch(p.args.start_date),
        dateArgToEpoch(p.args.end_date),
      );
      out.emit(distributionsBatch(schema, rows));
      state.done = true;
    },
    examples: [
      { sql: "SELECT ex_date, amount_per_share FROM invesco.main.distributions('RSP') ORDER BY ex_date DESC LIMIT 8", description: "Recent RSP distributions" },
      { sql: "SELECT sum(amount_per_share) AS total FROM invesco.main.distributions('RSP', start_date := DATE '2025-01-01')", description: "Total distributions since a start date" },
    ],
    tags: {
      "vgi.category": "history",
      "vgi.doc_llm":
        "Distribution (dividend / capital-gain) history for a fund: ex / record / payable dates, " +
        "the total per-share amount, and its ordinary-income, short/long-term capital-gain, and " +
        "return-of-capital components. Amounts are per-share dollars, not percents. Bound the " +
        "ex-date range with start_date/end_date.",
      "vgi.doc_md":
        "## distributions\n\n" +
        "Distribution history, one row per distribution. Amounts are **per-share** dollars (not " +
        "percentages), with the ordinary-income / capital-gain / return-of-capital breakdown. Bound " +
        "the ex-date range with `start_date`/`end_date` (see the example queries).",
      "vgi.result_columns_schema": resultColumnsSchema(distributionsSchema(), DISTRIBUTIONS_DESCS),
    },
  });
}

// ── nav_history ─────────────────────────────────────────────────────────────

interface NavHistoryArgs {
  fund: string;
  start_date: Date | null;
  end_date: Date | null;
}

const NAV_RANGE_DOCS = {
  start_date:
    "Optional inclusive lower bound on the valuation-day range — omit for the full history back " +
    "to inception. Filters client-side.",
  end_date:
    "Optional inclusive upper bound on the valuation-day range — omit for no upper bound. Named " +
    "end_date because END is a reserved SQL keyword.",
};

export function makeNavHistoryFunction(get: InvescoGet) {
  const schema = navHistorySchema();
  return defineTableFunction<NavHistoryArgs, DoneState>({
    name: "nav_history",
    description:
      "Daily net-asset-value history for a fund — one row per valuation day with the NAV, back to " +
      "inception. `fund` is a ticker; bound the valuation-date range with start_date/end_date.",
    args: { fund: new Utf8(), start_date: new DateDay(), end_date: new DateDay() },
    argDefaults: { start_date: null, end_date: null },
    argDocs: { fund: FUND_ARG_DOC, ...NAV_RANGE_DOCS },
    onBind: (p) => {
      required("nav_history", "fund", p.args.fund);
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const product = await resolveOrThrow("nav_history", get, String(p.args.fund));
      const rows = await fetchNavHistory(
        get,
        String(product.cusip),
        dateArgToEpoch(p.args.start_date),
        dateArgToEpoch(p.args.end_date),
      );
      out.emit(navHistoryBatch(schema, rows));
      state.done = true;
    },
    examples: [
      { sql: "SELECT as_of_date, nav FROM invesco.main.nav_history('RSP', start_date := DATE '2025-01-01') ORDER BY as_of_date DESC", description: "Daily RSP NAV since a start date" },
      { sql: "SELECT min(nav), max(nav) FROM invesco.main.nav_history('RSP', start_date := DATE '2025-01-01', end_date := DATE '2025-12-31')", description: "NAV range over a bounded window" },
    ],
    tags: {
      "vgi.category": "history",
      "vgi.doc_llm":
        "Daily NAV time series for a fund, back to inception. Each row carries the valuation date " +
        "and the net asset value per share. Bound the range with start_date/end_date. Use it for " +
        "NAV-based return series. This is fund NAV, not intraday candles.",
      "vgi.doc_md":
        "## nav_history\n\n" +
        "Daily NAV history back to inception, one row per valuation day. Bound the range with " +
        "`start_date`/`end_date` (inclusive SQL `DATE`s; omit for the full history). This is " +
        "**fund NAV**, not an intraday candle series (see the example queries).",
      "vgi.result_columns_schema": resultColumnsSchema(navHistorySchema(), NAV_HISTORY_DESCS),
    },
  });
}
