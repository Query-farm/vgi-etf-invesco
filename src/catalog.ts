// The `invesco` catalog descriptor + its metadata tags (the vgi.* discovery/doc channels
// vgi-lint grades). Invesco's public product/holdings endpoints are KEYLESS, so there is NO
// secret type here.
//
// Tag shapes follow vgi-lint's TAGS.md: JSON-valued tags (keywords/categories/
// executable_examples/agent_test_tasks) are JSON strings; all example SQL is catalog-qualified
// (invesco.main.<fn>) so it binds/runs when the catalog is attached.

import type { CatalogDescriptor, VgiFunction } from "@query-farm/vgi";
import { Arguments } from "@query-farm/vgi";
import { productsSchema, holdingsSchema, resultColumnsSchema } from "./schema.js";

const REPO = "https://github.com/Query-farm/vgi-etf-invesco";
const ISSUES = `${REPO}/issues`;

/** Per-column comments for the products table (surface as Arrow field metadata). */
const PRODUCTS_COLUMN_COMMENTS: Record<string, string> = {
  ticker: "Exchange ticker (e.g. RSP).",
  cusip: "CUSIP identifier (the key Invesco's per-fund resources use).",
  isin: "ISIN identifier.",
  sedol: "SEDOL identifier.",
  name: "Fund name as marketed, e.g. 'Invesco S&P 500 Equal Weight ETF'.",
  asset_class: "Asset class (Equity, Fixed Income, Alternative, Balanced).",
  asset_sub_class: "Asset sub-class, e.g. 'U.S. Equity'.",
  asset_sub_sub_class: "Finer asset classification, e.g. 'U.S. Core Equity'.",
  investment_method: "Passive or Active.",
  strategy: "Invesco strategy label / tracked index, e.g. 'IDXEQ - S&P 500 Equal Weight'.",
  umbrella: "The fund trust / umbrella the share class belongs to.",
  distribution_frequency: "How often the fund distributes (e.g. Quarterly).",
  base_currency: "The fund's base currency (e.g. USD).",
  bloomberg_ticker: "Bloomberg ticker of the tracked index, when published.",
  region: "Domicile / marketing region (e.g. United States).",
  inception_date: "Fund inception date.",
  expense_ratio_percent: "Total expense ratio, percent points (0.2 = 0.20%).",
  net_expense_ratio_percent: "Net expense ratio after waivers, percent points.",
  product_page_url: "Path to the fund page on invesco.com.",
  factsheet_url: "Path to the fund fact-sheet PDF.",
};

/** Table-level metadata for the products base table (the vgi.* doc/discovery channels). */
const PRODUCTS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "catalog",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "fund catalog",
    "product list",
    "expense ratio",
    "ticker",
    "CUSIP",
    "asset class",
  ]),
  "vgi.doc_llm":
    "The Invesco ETF catalog as a plain table (query it directly, no arguments): one row per US " +
    "ETF with ticker, CUSIP and other identifiers, name, asset classification, expense ratios, " +
    "inception date, strategy, and distribution frequency. Narrow it with a WHERE clause on " +
    "ticker, asset_class, investment_method, and so on. Percent columns hold percent points (0.2 " +
    "means 0.20%). Start here to find a fund's ticker for the other functions.",
  "vgi.doc_md":
    "## products\n\n" +
    "The Invesco US ETF catalog as a base table — one row per fund. It takes no arguments; query " +
    "it directly and filter with a WHERE clause (e.g. `WHERE asset_class = 'Equity' ORDER BY " +
    "expense_ratio_percent`; see the example queries). Percent columns (`*_percent`) are in " +
    "**percent points** (an expense ratio of 0.2 means 0.20%). The ticker column is the key for " +
    "the other functions.",
  "vgi.example_queries": JSON.stringify([
    { description: "Cheapest Invesco ETFs by expense ratio", sql: "SELECT ticker, name, expense_ratio_percent FROM invesco.main.products ORDER BY expense_ratio_percent LIMIT 10" },
    { description: "Fixed-income ETFs", sql: "SELECT ticker, name, expense_ratio_percent FROM invesco.main.products WHERE asset_class = 'Fixed Income' ORDER BY name" },
    { description: "Look up a single fund by ticker", sql: "SELECT ticker, name, expense_ratio_percent FROM invesco.main.products WHERE ticker = 'RSP'" },
  ]),
  "vgi.result_columns_schema": resultColumnsSchema(productsSchema(), PRODUCTS_COLUMN_COMMENTS),
};

/** Per-column comments for the holdings table. */
const HOLDINGS_COLUMN_COMMENTS: Record<string, string> = {
  fund_ticker: "The fund's ticker (e.g. RSP) — the hive partition key; constant for every row of a fund. Filter on it to pick funds; omit to stream all.",
  as_of_date: "The effective date Invesco reports for these holdings (current holdings only).",
  name: "Constituent / issuer name.",
  ticker: "Constituent ticker (the holding's own ticker; distinct from fund_ticker).",
  cusip: "Constituent CUSIP.",
  weight_percent: "Percent of the fund, 0–100 (0.33 = 0.33%; weights sum to ~100).",
  market_value: "Market value held, in the fund's base currency.",
  units: "Quantity held, as a count of shares/units (or par for bonds).",
  sec_type: "Security type classification (e.g. Common Stock, Corporate Bond).",
  currency: "Currency of the position.",
  coupon_percent: "Coupon rate, percent points (fixed income only).",
  maturity_date: "Maturity date (fixed income only).",
  next_call_date: "Next call date (fixed income only).",
  rating: "S&P / Moody's rating string (fixed income only).",
};

/** Table-level metadata for the holdings base table (fund-partitioned, current-only). */
const HOLDINGS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "holdings",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "holdings",
    "constituents",
    "portfolio",
    "weights",
    "positions",
    "exposure",
  ]),
  "vgi.doc_llm":
    "Detailed current portfolio holdings for Invesco ETFs as a hive-partitioned table. It is " +
    "partitioned by fund_ticker (the FUND's ticker, distinct from the constituent `ticker` " +
    "column): filter `WHERE fund_ticker = '…'` (or `fund_ticker IN (…)`) to pick funds, or scan " +
    "with no filter to stream EVERY fund's holdings (a couple hundred funds — slow, so prefer a " +
    "filter). Holdings are current-only — Invesco reports a single effective date (the as_of_date " +
    "column), with no historical time travel. Rows come back weight-descending; weight_percent is " +
    "in percent points (0.33 = 0.33%); bond funds also fill coupon/maturity/rating. Join on " +
    "fund_ticker to products.ticker for fund-level facts.",
  "vgi.doc_md":
    "## holdings\n\n" +
    "Detailed **current** fund holdings as a **hive-partitioned table**, partitioned by " +
    "`fund_ticker` (the fund's ticker). `fund_ticker` is distinct from `ticker` (the constituent's " +
    "own ticker). Filter `WHERE fund_ticker = 'RSP'` for one fund, or scan with no filter to stream " +
    "every fund (see the example queries).\n\n" +
    "`WHERE fund_ticker IN ('RSP','SPHQ')` fans out per partition; an unfiltered scan streams every " +
    "fund (a couple hundred partitions — slow). Holdings are **current-only** (Invesco reports one " +
    "effective date; no time travel). `weight_percent` is in percent points (0.33 = 0.33%).",
  "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_COLUMN_COMMENTS),
  "vgi.example_queries": JSON.stringify([
    { description: "Top 10 current holdings of RSP", sql: "SELECT ticker, name, weight_percent FROM invesco.main.holdings WHERE fund_ticker = 'RSP' ORDER BY weight_percent DESC LIMIT 10" },
    { description: "Two funds at once (partition fan-out)", sql: "SELECT fund_ticker, ticker, weight_percent FROM invesco.main.holdings WHERE fund_ticker IN ('RSP', 'SPHQ')" },
    { description: "A bond fund also fills coupon / maturity / rating", sql: "SELECT name, coupon_percent, maturity_date, rating, weight_percent FROM invesco.main.holdings WHERE fund_ticker = 'BSCR' LIMIT 5" },
  ]),
};

/** Catalog-level tags: docs, discovery, provenance, and the agent-test suite. */
const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Invesco ETFs",
  "vgi.doc_llm":
    "Invesco US ETF data as SQL tables and table functions. Reach for it to screen the ETF " +
    "lineup on key facts (expense ratio, asset class, strategy), to inspect what a fund currently " +
    "holds, and to pull per-fund history like distributions and NAV series. The central concept " +
    "is the fund, identified by its exchange ticker (e.g. RSP); start from the catalog to find " +
    "that key, then drill into a specific fund. Holdings are current-only (no historical as-of). " +
    "Data is Invesco's public product feed: best-effort, for informational use.",
  "vgi.doc_md":
    "## Invesco ETFs\n\n" +
    "Invesco US ETF data, exposed as DuckDB tables and table functions.\n\n" +
    "The **fund** is the unit of the data and is keyed by an exchange `ticker` (e.g. `RSP`) — begin " +
    "at the catalog to discover that key, then drill into a fund. Fund holdings are " +
    "**current-only**: Invesco reports a single effective date per fund, so there is no historical " +
    "time travel (unlike some other providers).\n\n" +
    "Data is provided for informational use; review Invesco's terms before redistribution.",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "Invesco",
    "holdings",
    "portfolio",
    "fund",
    "NAV",
    "distributions",
    "dividends",
    "expense ratio",
    "index fund",
  ]),
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC",
  "vgi.license": "MIT",
  "vgi.support_contact": ISSUES,
  "vgi.support_policy_url": ISSUES,
  // At least one guaranteed-runnable example at the catalog level (VGI509). No expected_result —
  // Invesco data is live/non-deterministic.
  "vgi.executable_examples": JSON.stringify([
    {
      name: "cheapest_etfs",
      description: "The cheapest Invesco ETFs by expense ratio",
      sql: "SELECT ticker, name, expense_ratio_percent FROM invesco.main.products ORDER BY expense_ratio_percent LIMIT 5",
    },
    {
      name: "top_holdings",
      description: "The top holdings of the Invesco S&P 500 Equal Weight ETF",
      sql: "SELECT ticker, name, weight_percent FROM invesco.main.holdings WHERE fund_ticker = 'RSP' ORDER BY weight_percent DESC LIMIT 5",
    },
  ]),
  // Agent-suitability suite (catalog only). Each task carries a deterministic check_sql that
  // asserts specific ground truth; reference_sql is omitted (live data + free-form analyst
  // queries won't reproduce an exact result set). success_criteria records what a correct answer
  // looks like for the LLM judge.
  "vgi.agent_test_tasks": JSON.stringify([
    {
      name: "rsp_exists",
      prompt: "Does Invesco offer an ETF with the ticker RSP, and what is it called?",
      check_sql: "SELECT count(*) > 0 FROM invesco.main.products WHERE ticker = 'RSP'",
      success_criteria: "The answer confirms RSP is the Invesco S&P 500 Equal Weight ETF, found via the products table.",
    },
    {
      name: "rsp_top_holding",
      prompt: "What is the single largest holding of the Invesco S&P 500 Equal Weight ETF (RSP) right now?",
      check_sql: "SELECT count(*) > 0 FROM invesco.main.holdings WHERE fund_ticker = 'RSP'",
      success_criteria: "The answer names RSP's top holding by weight, obtained from the holdings table.",
    },
    {
      name: "rsp_holdings_scan",
      prompt: "Using the holdings backing scan, list a few RSP constituents by weight.",
      check_sql: "SELECT count(*) > 0 FROM invesco.main.holdings_scan() WHERE fund_ticker = 'RSP'",
      success_criteria: "The answer returns RSP constituents via holdings_scan() filtered by ticker.",
    },
    {
      name: "rsp_expense_ratio",
      prompt: "What is the expense ratio of the Invesco S&P 500 Equal Weight ETF (RSP)?",
      check_sql: "SELECT count(*) > 0 FROM invesco.main.products WHERE ticker = 'RSP' AND expense_ratio_percent IS NOT NULL",
      success_criteria: "The answer reports RSP's expense ratio (a small percentage) from the products table.",
    },
    {
      name: "rsp_benchmark",
      prompt: "Which benchmark does the Invesco S&P 500 Equal Weight ETF (RSP) track, and what is its P/E ratio?",
      check_sql: "SELECT count(*) > 0 FROM invesco.main.fund_details('RSP') WHERE primary_benchmark IS NOT NULL",
      success_criteria: "The answer names RSP's primary benchmark (the S&P 500 Equal Weight Index) from the fund_details function.",
    },
    {
      name: "rsp_nav_history",
      prompt: "What has the Invesco S&P 500 Equal Weight ETF's (RSP) NAV done since the start of 2025?",
      check_sql: "SELECT count(*) > 0 FROM invesco.main.nav_history('RSP', start_date := DATE '2025-01-01') WHERE nav > 0",
      success_criteria: "The answer summarizes RSP's NAV over the period, obtained from the nav_history function.",
    },
    {
      name: "rsp_last_distribution",
      prompt: "When did the Invesco S&P 500 Equal Weight ETF (RSP) most recently pay a distribution, and how much?",
      check_sql: "SELECT count(*) > 0 FROM invesco.main.distributions('RSP')",
      success_criteria: "The answer gives RSP's most recent distribution (ex date and per-share amount) from the distributions function.",
    },
  ]),
};

/** Schema-level tags: docs, discovery, the category registry, and shown examples. */
const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Invesco Fund Data",
  "vgi.doc_llm":
    "Functions that return Invesco ETF data at two levels. At the catalog level you screen the " +
    "whole lineup on key facts and resolve a fund's key. At the fund level you drill into one " +
    "fund — its current holdings, its characteristics, and its distribution and NAV history. A " +
    "fund is keyed by its exchange `ticker` (e.g. `RSP`); resolve the key at the catalog level " +
    "first. Holdings are current-only (no historical as-of).",
  "vgi.doc_md":
    "## Invesco fund data\n\n" +
    "Work happens at two levels. **Catalog level:** screen the lineup on key facts and find a " +
    "fund's key. **Fund level:** drill into a single fund — its current constituents, " +
    "characteristics, and time series. A fund is keyed by its exchange `ticker` (e.g. `RSP`).\n\n" +
    "Holdings are current-only: Invesco reports one effective date per fund, with no historical " +
    "time travel.",
  "vgi.keywords": JSON.stringify(["ETF holdings", "fund catalog", "NAV history", "distributions", "portfolio"]),
  domain: "finance",
  // Ordered navigation registry; each `name` is referenced by a function's vgi.category.
  "vgi.categories": JSON.stringify([
    { name: "catalog", title: "Fund Catalog", description: "The ETF list and per-fund characteristics." },
    { name: "holdings", title: "Holdings", description: "Detailed current portfolio holdings." },
    { name: "history", title: "History", description: "Per-fund distribution and NAV time series." },
  ]),
  "vgi.example_queries": JSON.stringify([
    { description: "Cheapest Invesco ETFs by expense ratio", sql: "SELECT ticker, name, expense_ratio_percent FROM invesco.main.products ORDER BY expense_ratio_percent LIMIT 10" },
    { description: "Top holdings of RSP", sql: "SELECT ticker, name, weight_percent FROM invesco.main.holdings WHERE fund_ticker = 'RSP' ORDER BY weight_percent DESC LIMIT 10" },
    { description: "Recent NAV history for RSP", sql: "SELECT as_of_date, nav FROM invesco.main.nav_history('RSP', start_date := DATE '2025-01-01') ORDER BY as_of_date DESC" },
  ]),
};

/**
 * @param functions    the callable table functions (fund_details, distributions, nav_history) —
 *                      NOT products or holdings, which are base tables.
 * @param productsScan  the zero-arg scan backing the `products` base table.
 * @param holdingsScan  the pushdown scan backing the `holdings` base table.
 * Both scans are registered for scan dispatch but exposed to DuckDB only as tables.
 */
export function makeCatalog(
  functions: VgiFunction[],
  productsScan: VgiFunction,
  holdingsScan: VgiFunction,
): CatalogDescriptor {
  return {
    name: "invesco",
    defaultSchema: "main",
    comment:
      "Invesco US ETF data as DuckDB tables: products (catalog) & holdings (fund-partitioned, " +
      "current-only) tables, plus fund_details, distributions, nav_history — vgi-etf-invesco",
    sourceUrl: REPO,
    tags: CATALOG_TAGS,
    schemas: [
      {
        name: "main",
        comment: "Invesco fund data: ETF catalog, detailed current holdings, and per-fund history.",
        tags: SCHEMA_TAGS,
        functions: [...functions, holdingsScan],
        tables: [
          {
            name: "products",
            function: productsScan,
            arguments: new Arguments([], new Map()),
            // Each fund has a unique CUSIP (advisory — not enforced on scan).
            primaryKey: [["cusip"]],
            // The Invesco US ETF lineup is ~245 funds; headroom to ~400.
            inlinedCardinality: { estimate: 245n, max: 400n },
            comment:
              "Every Invesco US ETF with its key facts, one row per fund. Query directly (no " +
              "arguments) and filter with WHERE; percent columns are in percent points.",
            columnComments: PRODUCTS_COLUMN_COMMENTS,
            tags: PRODUCTS_TABLE_TAGS,
          },
          {
            name: "holdings",
            function: holdingsScan,
            arguments: new Arguments([], new Map()),
            // fund_ticker is always populated (the scan tags every row with its fund).
            notNull: ["fund_ticker"],
            // Hive partition key: fund_ticker. A WHERE fund_ticker = … / IN (…) filter is pushed
            // down to fetch just those funds; an unfiltered scan streams every fund (all
            // partitions). Invesco holdings are current-only — NO time travel.
            // Whole-table estimate: ~245 funds; an equity fund is ~500 rows, a bond fund similar.
            inlinedCardinality: { estimate: 120000n, max: 500000n },
            comment:
              "Detailed current fund holdings, hive-partitioned by fund_ticker (filter WHERE " +
              "fund_ticker = … for one fund, or scan unfiltered for all). Current-only — no time " +
              "travel; as_of_date reflects Invesco's reported effective date.",
            columnComments: HOLDINGS_COLUMN_COMMENTS,
            tags: HOLDINGS_TABLE_TAGS,
          },
        ],
      },
    ],
  };
}
