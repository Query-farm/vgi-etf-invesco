// The Invesco driver — pure logic, no network and no SDK. Every fetch* takes an injected
// `get(url) => Promise<any>` so the archetype-proof tests drive it against an in-process fake
// and the worker wires the real HTTP client (client.ts). This module MUST NOT import from
// @query-farm/* — the unit tests import it without the SDK installed.
//
// Invesco exposes a KEYLESS JSON API on its cache CDN host (dng-api.invesco.com). Two planes back
// the tables and functions:
//
//   /product/search?…                                    → products  (a Solr-style catalog, one doc
//     per US ETF share class; also the ticker→CUSIP resolver)
//   /cache/v1/accounts/en_US/shareclasses/<CUSIP>/…      → holdings, fund_details, distributions,
//     nav_history (per-fund resources, all keyed by CUSIP with idType=cusip)
//
// The API keys funds by CUSIP: the ticker idType works for a few catalog resources but returns
// 5xx for holdings & per-fund details, so we resolve ticker→CUSIP against the (cached) catalog
// and use idType=cusip everywhere (mirrors how the sibling iShares worker resolves ticker→id).
//
// Every parser is defensive: a missing key / container / array degrades to an empty result or a
// null cell rather than throwing. `resolveFund` returns null (not a throw) on an unresolvable
// ticker so the caller (functions.ts) can raise a typed SDK error.
//
// IMPORTANT — Invesco holdings are CURRENT-only: each fund reports a single effectiveDate, with no
// arbitrary historical as-of. So `holdings` is hive-partitioned by fund but has NO time travel.

export const INVESCO_HOST = "https://dng-api.invesco.com";

// ── product catalog / resolver (Solr-style /product/search) ─────────────────────
//
// The field list we ask Solr for. NOTE: pairing a `sort=` param with certain `fl` fields trips the
// edge WAF with a 406, so we deliberately omit `sort` and order client-side / in SQL.
const SEARCH_FIELDS = [
  "uniqueIdentifier", "cusip", "title", "accountName", "isin", "sedol", "ticker",
  "bloombergTicker", "assetClass", "assetSubClass", "assetSubSubClass", "inceptionDate",
  "totalExpenseRatio", "netExpenseRatio", "distributionFrequency", "strategy", "umbrella",
  "investmentMethod", "baseCurrency", "region", "url", "factsheet",
].join(",");

/** The US ETF product catalog: one Solr doc per open ETF share class. Backs products + resolveFund. */
export const SEARCH_URL =
  `${INVESCO_HOST}/product/search` +
  `?fq=countryCode:%22US%22&fq=language:%22en_us%22&fq=accountType:%22ETF%22` +
  `&fq=contentType:%22Product%22&fq=shareClassStatus:%22open%22&q=_suggest_:*` +
  `&fl=${encodeURIComponent(SEARCH_FIELDS)}&rows=2000&start=0`;

// ── per-fund cache resources (all keyed by CUSIP) ───────────────────────────────

/** Build a per-fund cache-resource URL for a CUSIP, with idType=cusip + productType=ETF. */
export function shareclassUrl(
  cusip: string,
  path = "",
  params: Record<string, string> = {},
): string {
  const base = `${INVESCO_HOST}/cache/v1/accounts/en_US/shareclasses/${encodeURIComponent(
    cusip.trim(),
  )}${path}`;
  const qs = new URLSearchParams({ idType: "cusip", productType: "ETF", ...params });
  return `${base}?${qs.toString()}`;
}

export const holdingsUrl = (cusip: string): string => shareclassUrl(cusip, "/holdings/fund");
export const keyStatsUrl = (cusip: string): string => shareclassUrl(cusip, "/keyStats");
export const fundDetailsUrl = (cusip: string): string =>
  shareclassUrl(cusip, "", { expand: "nav", variationType: "fundDetails" });
export const characteristicsUrl = (cusip: string): string =>
  shareclassUrl(cusip, "", { variationType: "fundCharacteristics" });
export const pricesUrl = (cusip: string): string =>
  shareclassUrl(cusip, "/prices", { variationType: "priceListing" });
export const performanceUrl = (cusip: string): string =>
  shareclassUrl(cusip, "/performance/standard", {
    performanceSubType: "annualized",
    performancePeriod: "monthly",
  });
export const distributionUrl = (cusip: string): string =>
  shareclassUrl(cusip, "/distribution", { loadType: "initial" });
export const navsUrl = (cusip: string): string => shareclassUrl(cusip, "/navs");

// ── shared value coercion ────────────────────────────────────────────────────

/** True for "no data" cells: null, "", or all-whitespace. */
function isBlank(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  return false;
}

/** A trimmed display string, or null when blank. */
export function str(v: unknown): string | null {
  if (isBlank(v)) return null;
  return String(v).trim();
}

/**
 * A number from an Invesco value. Handles bare numbers and string forms ("0.2", "12.03") — strips
 * `$`, `,`, `%`, and spaces. Null when blank / non-numeric.
 */
export function num(v: unknown): number | null {
  if (isBlank(v)) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Take the first element of an array-or-scalar (Solr multi-valued fields arrive as arrays). */
function firstOf(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * An Invesco date → epoch SECONDS at UTC midnight of the CALENDAR day. Accepts both shapes the
 * API emits: ISO `YYYY-MM-DD` (most resources) and US `MM/DD/YYYY` (the navs line chart). We keep
 * only the calendar parts so no zone offset can shift the reported day. Null when absent /
 * unparseable; validates the parts round-trip so an impossible date returns null.
 */
export function dateSec(v: unknown): number | null {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  let y: number, mo: number, d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    y = Number(iso[1]);
    mo = Number(iso[2]);
    d = Number(iso[3]);
  } else {
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    if (!us) return null;
    mo = Number(us[1]);
    d = Number(us[2]);
    y = Number(us[3]);
  }
  const ms = Date.UTC(y, mo - 1, d);
  if (Number.isNaN(ms)) return null;
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.floor(ms / 1000);
}

/** Decode the few HTML entities Invesco leaves in display labels (e.g. `S&amp;P`). */
export function decodeEntities(s: string | null): string | null {
  if (s == null) return null;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

// ── DATE-typed function arguments ──────────────────────────────────────────────
//
// Date args on the table functions are real SQL DATE (Arrow Date32), so DuckDB parses and
// type-checks the literal and the SDK hands us a value — no YYYY-MM-DD strings on the SQL surface.
// `dateArgToEpoch` accepts the runtime's epoch-ms number (verified: `DATE '2026-01-01'` →
// 1767225600000) plus, defensively, a JS Date, a bigint, a days-since-epoch number, or a
// YYYY-MM-DD string, so it is robust to the representation. Used for the client-side
// start_date/end_date range filters (the Invesco URLs carry no date parameter).

/** A DATE arg → epoch SECONDS at UTC midnight, or null when absent/invalid. */
export function dateArgToEpoch(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(t);
    if (!m) return null;
    return dateSec(`${m[1]}-${m[2]}-${m[3]}`);
  }
  let ms: number;
  if (v instanceof Date) ms = v.getTime();
  else if (typeof v === "bigint") ms = Number(v);
  else if (typeof v === "number" && Number.isFinite(v)) {
    // Disambiguate by magnitude: >= 1e11 is epoch milliseconds; smaller is days-since-epoch.
    ms = Math.abs(v) >= 1e11 ? v : v * 86400000;
  } else return null;
  return Number.isNaN(ms) ? null : Math.floor(ms / 86400000) * 86400;
}

// ── products (the /product/search catalog) ──────────────────────────────────────

export interface ProductRow {
  ticker: string | null;
  cusip: string | null;
  isin: string | null;
  sedol: string | null;
  name: string | null;
  asset_class: string | null;
  asset_sub_class: string | null;
  asset_sub_sub_class: string | null;
  investment_method: string | null;
  strategy: string | null;
  umbrella: string | null;
  distribution_frequency: string | null;
  base_currency: string | null;
  bloomberg_ticker: string | null;
  region: string | null;
  inception_date: number | null;
  expense_ratio_percent: number | null;
  net_expense_ratio_percent: number | null;
  product_page_url: string | null;
  factsheet_url: string | null;
}

/** Map one Solr catalog doc to a product row. */
export function parseProductDoc(doc: unknown): ProductRow | null {
  if (doc == null || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  const ticker = str(firstOf(d.ticker));
  if (!ticker) return null;
  return {
    ticker: ticker.toUpperCase(),
    cusip: str(firstOf(d.cusip)),
    isin: str(firstOf(d.isin)),
    sedol: str(firstOf(d.sedol)),
    name: str(firstOf(d.accountName)) ?? decodeEntities(str(firstOf(d.title))),
    asset_class: str(firstOf(d.assetClass)),
    asset_sub_class: str(firstOf(d.assetSubClass)),
    asset_sub_sub_class: str(firstOf(d.assetSubSubClass)),
    investment_method: str(firstOf(d.investmentMethod)),
    strategy: str(firstOf(d.strategy)),
    umbrella: str(firstOf(d.umbrella)),
    distribution_frequency: str(firstOf(d.distributionFrequency)),
    base_currency: str(firstOf(d.baseCurrency)),
    bloomberg_ticker: str(firstOf(d.bloombergTicker)),
    region: str(firstOf(d.region)),
    inception_date: dateSec(firstOf(d.inceptionDate)),
    expense_ratio_percent: num(firstOf(d.totalExpenseRatio)),
    net_expense_ratio_percent: num(firstOf(d.netExpenseRatio)),
    product_page_url: str(firstOf(d.url)),
    factsheet_url: str(firstOf(d.factsheet)),
  };
}

/**
 * Map the /product/search envelope to product rows. `ticker`, when non-empty, narrows to that one
 * ticker (case-insensitive). Rows without a ticker are dropped.
 */
export function parseProducts(json: unknown, ticker = ""): ProductRow[] {
  const docs = (json as { response?: { docs?: unknown } } | null | undefined)?.response?.docs;
  if (!Array.isArray(docs)) return [];
  const wantTicker = ticker.trim().toUpperCase();
  const rows: ProductRow[] = [];
  for (const doc of docs) {
    const row = parseProductDoc(doc);
    if (!row || !row.ticker) continue;
    if (wantTicker && row.ticker !== wantTicker) continue;
    rows.push(row);
  }
  return rows;
}

export async function fetchProducts(
  get: (url: string) => Promise<unknown>,
  ticker = "",
): Promise<ProductRow[]> {
  return parseProducts(await get(SEARCH_URL), ticker);
}

// ── fund resolution (accept a ticker or a CUSIP; validate against the catalog) ────

/**
 * Resolve a `fund` argument to its catalog row. A `fund` may be an exchange ticker (e.g. 'RSP')
 * or a raw CUSIP; both are matched (case-insensitive) against the cached catalog, so the caller
 * gets the fund's CUSIP (what every per-fund resource is keyed by) plus its identity fields.
 * Returns null when nothing matches (the caller raises a typed ArgumentValidationError — this
 * module stays SDK-free).
 */
export async function resolveFund(
  get: (url: string) => Promise<unknown>,
  fund: string,
): Promise<ProductRow | null> {
  const wanted = fund.trim().toUpperCase();
  if (wanted === "") return null;
  const products = parseProducts(await get(SEARCH_URL));
  return (
    products.find(
      (p) =>
        (p.ticker ?? "").toUpperCase() === wanted || (p.cusip ?? "").toUpperCase() === wanted,
    ) ?? null
  );
}

// ── holdings (/holdings/fund) ───────────────────────────────────────────────────

export interface HoldingRow {
  /** The fund's ticker — the partition key (constant per fund; distinct from the constituent `ticker`). */
  fundTicker: string | null;
  asOfDate: number | null;
  name: string | null;
  ticker: string | null;
  cusip: string | null;
  weightPercent: number | null;
  marketValue: number | null;
  units: number | null;
  secType: string | null;
  currency: string | null;
  // Fixed-income-only fields (null for equity funds).
  couponPercent: number | null;
  maturityDate: number | null;
  nextCallDate: number | null;
  rating: string | null;
}

/** Map a /holdings/fund envelope to holding rows, sorted by weight desc (NULLS last). */
export function parseHoldings(json: unknown, fundTicker: string | null = null): HoldingRow[] {
  const env = (json as Record<string, unknown> | null | undefined) ?? {};
  const asOf = dateSec(env.effectiveDate) ?? dateSec(env.effectiveBusinessDate);
  const list = env.holdings;
  if (!Array.isArray(list)) return [];
  const rows: HoldingRow[] = [];
  for (const raw of list) {
    if (raw == null || typeof raw !== "object") continue;
    const h = raw as Record<string, unknown>;
    rows.push({
      fundTicker,
      asOfDate: asOf,
      name: str(h.issuerName),
      ticker: str(h.ticker),
      cusip: str(h.cusip),
      weightPercent: num(h.percentageOfTotalNetAssets),
      marketValue: num(h.marketValueBase),
      units: num(h.units),
      secType: str(h.securityTypeName),
      currency: str(h.currency),
      couponPercent: num(h.coupon),
      maturityDate: dateSec(h.maturityDate),
      nextCallDate: dateSec(h.nextCallDate),
      rating: str(h.spMoodysRating),
    });
  }
  // Invesco returns holdings weight-descending already; enforce it so `... LIMIT 10` is the top
  // holdings without an explicit ORDER BY. NULL weights sort last.
  rows.sort((a, b) => (b.weightPercent ?? -Infinity) - (a.weightPercent ?? -Infinity));
  return rows;
}

/** Detailed current holdings for one fund (by CUSIP). Returns Invesco's published positions. */
export async function fetchHoldings(
  get: (url: string) => Promise<unknown>,
  cusip: string,
  fundTicker: string,
): Promise<HoldingRow[]> {
  return parseHoldings(await get(holdingsUrl(cusip)), fundTicker.toUpperCase());
}

// ── fund_details (catalog identity + keyStats + fundDetails + characteristics +
//                  prices + performance, merged to one row) ──────────────────────

export interface FundDetailsRow {
  ticker: string | null;
  cusip: string | null;
  isin: string | null;
  name: string | null;
  asset_class: string | null;
  asset_sub_class: string | null;
  investment_method: string | null;
  strategy: string | null;
  inception_date: number | null;
  expense_ratio_percent: number | null;
  net_expense_ratio_percent: number | null;
  distribution_frequency: string | null;
  net_assets: number | null;
  num_holdings: number | null;
  as_of_date: number | null;
  nav: number | null;
  closing_price: number | null;
  shares_outstanding: number | null;
  premium_discount_percent: number | null;
  thirty_day_avg_volume: number | null;
  sec_yield_30day_percent: number | null;
  ytd_return_percent: number | null;
  pe_ratio: number | null;
  forward_pe_ratio: number | null;
  pb_ratio: number | null;
  return_on_equity_percent: number | null;
  weighted_avg_market_cap: number | null;
  return_1y_percent: number | null;
  return_3y_percent: number | null;
  return_5y_percent: number | null;
  return_10y_percent: number | null;
  return_since_inception_percent: number | null;
  primary_benchmark: string | null;
  benchmark_return_1y_percent: number | null;
}

/** Reduce a keyStats envelope (`{keyStats:[{name,value}]}`) to a name→value map. */
function keyStatsMap(json: unknown): Map<string, number | null> {
  const arr = (json as { keyStats?: unknown } | null | undefined)?.keyStats;
  const m = new Map<string, number | null>();
  if (Array.isArray(arr)) {
    for (const it of arr) {
      const name = str((it as Record<string, unknown>)?.name);
      if (name) m.set(name, num((it as Record<string, unknown>)?.value));
    }
  }
  return m;
}

/**
 * Merge the catalog identity row + the four live per-fund envelopes into one details row. All
 * inputs are optional and degrade to nulls.
 */
export function parseFundDetails(
  product: ProductRow | null,
  keyStats: unknown,
  fundDetails: unknown,
  characteristics: unknown,
  prices: unknown,
  performance: unknown,
): FundDetailsRow {
  const p = product ?? ({} as Partial<ProductRow>);
  const ks = keyStatsMap(keyStats);
  const fd = (fundDetails as Record<string, unknown> | null | undefined) ?? {};
  const ch = (characteristics as Record<string, unknown> | null | undefined) ?? {};
  const pr = (prices as Record<string, unknown> | null | undefined) ?? {};
  const perfArr = (performance as { annualizedPerformance?: unknown } | null | undefined)
    ?.annualizedPerformance;
  const perf = Array.isArray(perfArr) ? (perfArr as Record<string, unknown>[]) : [];
  const fund = perf.find((r) => str(r.label) === "fund") ?? {};
  const benchmark = perf.find((r) => str(r.label) === "benchmark") ?? {};
  return {
    ticker: p.ticker ?? null,
    cusip: p.cusip ?? null,
    isin: p.isin ?? null,
    name: p.name ?? null,
    asset_class: p.asset_class ?? null,
    asset_sub_class: p.asset_sub_class ?? null,
    investment_method: p.investment_method ?? null,
    strategy: p.strategy ?? null,
    inception_date: p.inception_date ?? null,
    expense_ratio_percent: p.expense_ratio_percent ?? null,
    net_expense_ratio_percent: p.net_expense_ratio_percent ?? null,
    distribution_frequency: p.distribution_frequency ?? null,
    net_assets: num(fd.shareclassTotalNetAssets),
    num_holdings: num(fd.totalNoOfHoldings),
    as_of_date: dateSec(fd.effectiveDate),
    nav: num(pr.nav),
    closing_price: num(pr.closingPrice),
    shares_outstanding: num(pr.sharesOutstanding),
    premium_discount_percent: num(pr.bidAskMidpointPremiumDiscountPercentage),
    thirty_day_avg_volume: num(pr["30dayAverageTradingVolume"]),
    sec_yield_30day_percent: ks.get("secYield30Day") ?? null,
    ytd_return_percent: ks.get("ytd") ?? num(fund.ytd),
    pe_ratio: num(ch.priceToEarningsRatio),
    forward_pe_ratio: num(ch.forwardPriceToEarningsRatio),
    pb_ratio: num(ch.priceToBookRatio),
    return_on_equity_percent: num(ch.returnOnEquity),
    weighted_avg_market_cap: num(ch.weightedAverageMarketCapatilization),
    return_1y_percent: num(fund.y1),
    return_3y_percent: num(fund.y3),
    return_5y_percent: num(fund.y5),
    return_10y_percent: num(fund.y10),
    return_since_inception_percent: num(fund.inception),
    primary_benchmark: decodeEntities(str(benchmark.displayLabel)),
    benchmark_return_1y_percent: num(benchmark.y1),
  };
}

export async function fetchFundDetails(
  get: (url: string) => Promise<unknown>,
  product: ProductRow,
): Promise<FundDetailsRow> {
  const cusip = String(product.cusip ?? "");
  const [keyStats, fundDetails, characteristics, prices, performance] = await Promise.all([
    get(keyStatsUrl(cusip)),
    get(fundDetailsUrl(cusip)),
    get(characteristicsUrl(cusip)),
    get(pricesUrl(cusip)),
    get(performanceUrl(cusip)),
  ]);
  return parseFundDetails(product, keyStats, fundDetails, characteristics, prices, performance);
}

// ── distributions (/distribution) ───────────────────────────────────────────────

export interface DistributionRow {
  exDate: number | null;
  recordDate: number | null;
  payDate: number | null;
  amountPerShare: number | null;
  ordinaryIncome: number | null;
  shortTermCapitalGain: number | null;
  longTermCapitalGain: number | null;
  returnOfCapital: number | null;
}

/** Map a distribution envelope's items, optionally bounded to [startSec, endSec] by ex-date. */
export function parseDistributions(
  json: unknown,
  startSec: number | null = null,
  endSec: number | null = null,
): DistributionRow[] {
  const items = (json as { distributions?: unknown } | null | undefined)?.distributions;
  if (!Array.isArray(items)) return [];
  const rows: DistributionRow[] = [];
  for (const raw of items) {
    if (raw == null || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    const exDate = dateSec(it.exDate);
    if (startSec != null && (exDate == null || exDate < startSec)) continue;
    if (endSec != null && (exDate == null || exDate > endSec)) continue;
    rows.push({
      exDate,
      recordDate: dateSec(it.recordDate),
      payDate: dateSec(it.payDate),
      amountPerShare: num(it.distributionAmountPerUnit),
      ordinaryIncome: num(it.ordinaryIncomeDistribution),
      shortTermCapitalGain: num(it.shortTermCapitalGainsDistribution),
      longTermCapitalGain: num(it.longTermCapitalGainsDistribution),
      returnOfCapital: num(it.returnOfCapitalDistribution),
    });
  }
  return rows;
}

export async function fetchDistributions(
  get: (url: string) => Promise<unknown>,
  cusip: string,
  startSec: number | null = null,
  endSec: number | null = null,
): Promise<DistributionRow[]> {
  return parseDistributions(await get(distributionUrl(cusip)), startSec, endSec);
}

// ── nav_history (/navs line chart, daily NAV series back to inception) ────────────

export interface NavHistoryRow {
  asOfDate: number | null;
  nav: number | null;
}

/** Map a /navs envelope's NAV line-chart series, optionally bounded to [startSec, endSec]. */
export function parseNavHistory(
  json: unknown,
  startSec: number | null = null,
  endSec: number | null = null,
): NavHistoryRow[] {
  const series = (json as { lineChartData?: unknown } | null | undefined)?.lineChartData;
  if (!Array.isArray(series)) return [];
  const nav = series.find((s) => str((s as Record<string, unknown>)?.type) === "NAV") ?? series[0];
  const data = (nav as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) return [];
  const rows: NavHistoryRow[] = [];
  for (const raw of data) {
    if (raw == null || typeof raw !== "object") continue;
    const pt = raw as Record<string, unknown>;
    const asOfDate = dateSec(pt.date);
    if (startSec != null && (asOfDate == null || asOfDate < startSec)) continue;
    if (endSec != null && (asOfDate == null || asOfDate > endSec)) continue;
    rows.push({ asOfDate, nav: num(pt.value) });
  }
  return rows;
}

export async function fetchNavHistory(
  get: (url: string) => Promise<unknown>,
  cusip: string,
  startSec: number | null = null,
  endSec: number | null = null,
): Promise<NavHistoryRow[]> {
  return parseNavHistory(await get(navsUrl(cusip)), startSec, endSec);
}
