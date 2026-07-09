# vgi-etf-invesco — agent notes

A VGI (DuckDB) worker exposing **Invesco** US ETF data as two base **tables** — `products` (the
catalog) and `holdings` (fund-partitioned, current-only) — plus table **functions**:
`fund_details`, `distributions`, `nav_history` (and the listed `holdings_scan` backing the
holdings table). TypeScript, runs on Bun, built on `@query-farm/vgi` (the TS SDK). Keyless — no
secret type, no auth. Modeled on the sibling `vgi-etf-vanguard` / `vgi-etf-ishares` workers.

## Base tables (`products`, `holdings`) — two layers: registry vs listing

Tables are wired via `SchemaDescriptor.tables` (`makeCatalog`'s `tables: [...]`); each
`TableDescriptor` has `function: <scan>` + `arguments: new Arguments([], new Map())` and carries
its docs on `tags`/`comment`/`columnComments`. Two INDEPENDENT layers matter:
- **FunctionRegistry** (`registry.register(scan)`) — the *dispatch* layer. Required for the table
  to be scannable.
- **catalog `schemas[].functions`** — the *listing* layer (DuckDB's `schemaContentsFunctions`).
  Controls what shows as a callable `X()` function AND is where the extension discovers a scan's
  capabilities (e.g. `filter_pushdown`).

`products`: backing `productsScan` is **registered but NOT listed** → exposed only as the table,
and it needs no pushdown. `holdings`: backing `holdingsScan` MUST be **listed**
(`functions: [...functions, holdingsScan]`) — proven in the sibling iShares worker that an unlisted
backing scan gets **no** `pushdown_filters` (the extension can't see its `filter_pushdown`
capability), so the `fund_ticker` partition filter never reaches it. Hence a visible
`holdings_scan()` function is unavoidable; VGI311 is waived in `vgi-lint.toml`.

## `holdings` — hive-partitioned by `fund_ticker`, CURRENT-only (NO time travel)

Query `FROM invesco.main.holdings WHERE fund_ticker = 'RSP'` (fund selector); an **unfiltered scan
streams every fund** (one partition per fund). Mechanics (mirror iShares'/vanguard's scan):
- **Hive partitioning + streaming queue.** `holdingsScan` is a `partitionKind:
  "SINGLE_VALUE_PARTITIONS"` generator — `fund_ticker` is the partition key (annotated
  `vgi.partition_column` in `holdingsSchema`). `onInit` reads the pushed `fund_ticker` filter (or,
  absent one, the whole ETF catalog), resolves each ticker to its CUSIP, and `queuePush`es one item
  per fund (`{ticker, cusip}`) onto a `BoundStorage` queue keyed by the execution id. `process()`
  pops one fund per tick, fetches its holdings by CUSIP, and `out.emit`s a single partition batch
  tagged with `vgi_partition_values` (min==max==ticker). `maxWorkers` workers drain the same queue →
  work-stealing fan-out. `LIMIT` short-circuits the stream, so `SELECT * FROM holdings LIMIT 5`
  fetches only ~1 fund.
- **Tolerant of a bad fund.** `process()` wraps `fetchHoldings` in try/catch and `continue`s on an
  error (404/5xx), so an all-funds scan is not killed by one dead fund. Empty partitions are also
  skipped.
- **No `requiredFieldFilterPaths`** — a bare scan defaults to ALL funds. Pushdown still narrows it:
  `onInit` reads `deserializeFilters(...).getColumnValues("fund_ticker")` (equality/IN).
- **`filterPushdown: true`** on `holdingsScan` + LISTED → the extension pushes the filter in.
- **NO `supportsTimeTravel`.** Invesco publishes only the current holdings for a fund (one reported
  effectiveDate), so there is no AT coordinate and the scan reads no `p.atValue`. This is the key
  intentional difference from vgi-etf-ishares. The source's effective date is surfaced as the
  `as_of_date` output column.
- **`fund_ticker` is a SEPARATE column from `ticker`** — `ticker` is the CONSTITUENT's own ticker;
  `fund_ticker` is the requested fund ticker, upper-cased, on every row. Constraints: `products`
  advisory PK `[cusip]`, `holdings` `notNull [fund_ticker]` (advisory PKs are NOT enforced on scan).
  No cross-table FK (ticker/cusip/isin/sedol recur with different meanings), and VGI807/809 are
  waived in `vgi-lint.toml` with reasons.

## Architecture (keep this separation)

- **`src/invesco.ts` — the pure driver.** URL builders + JSON→row parsers, plus thin `fetch*`
  orchestrators and `resolveFund` that take an injected `get(url) => Promise`. NO network, NO SDK
  import. This is what the unit tests exercise. All parsing is defensive: a missing key/container/
  array degrades to `[]` / `null` cells, never a throw. `resolveFund` returns `ProductRow | null`
  (null = fund not found) rather than throwing; `functions.ts` turns null into a typed
  `ArgumentValidationError`. Solr multi-valued fields can arrive as 1-element arrays → `firstOf()`.
- **`src/client.ts` — the only network module.** `makeInvescoGet()` returns the real `get`. Beyond
  `fetch` it: (1) sets the browser-like User-Agent + `Referer: https://www.invesco.com/` Invesco
  requires (the default fetch UA is rejected), (2) **retries 5xx** with backoff — the Fastly/Varnish
  edge intermittently 503s on a cold cache node (verified against `fundCharacteristics`); a client
  error (4xx) is terminal, and (3) memoizes the one `/product/search` catalog URL for 24 h (it backs
  both `products` and every ticker→CUSIP resolution). The cache logic + retry are unit-tested with
  an injected fetch/clock/sleep; the live path is exercised by the HTTP-transport E2E test.
- **`src/schema.ts` — typed Arrow schemas + batch builders.** ETF data has a stable shape, so we
  emit real typed columns (`Utf8`/`Float64`/`Int64`/`DateDay`), not JSON. Every calendar date is a
  real Arrow **DATE** (`DateDay` → DuckDB `DATE`, no timezone). `batchFromColumns` defaults to the
  **"rich"** representation, so a DATE cell is a **JS `Date`** (built at UTC midnight) and an Int64
  cell is a **bigint**. The driver returns dates as epoch seconds; the Date conversion lives only
  here. NOTE: dates are DATE, not TIMESTAMP — casting a UTC-midnight TIMESTAMPTZ `::DATE` shifts the
  day in non-UTC sessions. Percent columns carry a `_percent` suffix and hold **percent points**
  (`weight_percent` 0.33 = 0.33%, `expense_ratio_percent` 0.2 = 0.20%). Ratios that aren't percents
  (`pe_ratio`, `forward_pe_ratio`, `pb_ratio`) are NOT suffixed. `resultColumnsSchema()` builds the
  `vgi.result_columns_schema` tag DRY from an Arrow schema + a name→description map.
- **`src/functions.ts`** — five `defineTableFunction`s: `makeProductsScan` (unlisted products-table
  scan), `makeHoldingsScan` (listed holdings-table scan) plus `fund_details`, `distributions`,
  `nav_history`. Callable-function state is a `{done}` flag only (fully serializable → HTTP
  transport safe). Each function is a single-shot snapshot.
- **`src/catalog.ts` / `src/worker.ts`** — catalog descriptor (no `secretTypes`) and the entry that
  wires the real client into the functions.

## Invesco endpoint facts (why the design is what it is)

All keyless JSON on the cache CDN host `dng-api.invesco.com` (NOT the `www.invesco.com` SPA host,
which is JS-app / WAF-walled). All need only the browser User-Agent + Referer:

1. **Catalog / resolver** — `GET /product/search?fq=countryCode:"US"&fq=language:"en_us"&
   fq=accountType:"ETF"&fq=contentType:"Product"&fq=shareClassStatus:"open"&q=_suggest_:*&fl=…&
   rows=2000&start=0`. A Solr envelope `{response:{numFound, docs:[…]}}`; ~245 ETF docs. Per doc:
   `ticker, cusip, isin, sedol, accountName/title, assetClass/assetSubClass/assetSubSubClass,
   investmentMethod (Passive/Active), strategy, umbrella, distributionFrequency, baseCurrency,
   bloombergTicker, region, inceptionDate ("YYYY-MM-DD"), totalExpenseRatio/netExpenseRatio (string
   "0.2" = 0.20%), url, factsheet`. Backs `products` and the ticker→CUSIP resolution in
   `resolveFund`. GOTCHA: pairing a `sort=` param with the full `fl` list trips the edge WAF with a
   **406**, so we OMIT `sort` (SEARCH_URL) and order client-side / in SQL.
2. **Per-fund cache resources** — all
   `GET /cache/v1/accounts/en_US/shareclasses/<CUSIP>/<path>?idType=cusip&productType=ETF[&…]`.
   The API keys funds by **CUSIP**: `idType=ticker` works for a few resources but 5xxs for holdings
   & details, so we resolve ticker→CUSIP first and use `idType=cusip` everywhere.
   - `/holdings/fund` → `{cusip, effectiveDate, totalNumberOfHoldings, holdings:[{ticker,
     issuerName, units, percentageOfTotalNetAssets (0.33 = 0.33%), securityTypeName, marketValueBase,
     cusip, currency}]}` + for bonds `{coupon, maturityDate, nextCallDate, spMoodysRating}`. Backs
     `holdings`; `parseHoldings` sorts weight-desc.
   - `/keyStats` → `{keyStats:[{name:"ytd"|"secYield30Day", value, asOfDate}]}` → name→value map.
   - `?variationType=fundDetails&expand=nav` → `{shareclassTotalNetAssets, totalNoOfHoldings,
     effectiveDate}`.
   - `?variationType=fundCharacteristics` → `{priceToEarningsRatio, forwardPriceToEarningsRatio,
     priceToBookRatio, returnOnEquity, weightedAverageMarketCapatilization}` (note the API's
     misspelled `…Capatilization` key). Equity-only; bond funds return nulls.
   - `/prices?variationType=priceListing` → `{nav, closingPrice, sharesOutstanding,
     30dayAverageTradingVolume, bidAskMidpointPremiumDiscountPercentage}`.
   - `/performance/standard?performanceSubType=annualized&performancePeriod=monthly` →
     `{annualizedPerformance:[{ytd,y1,y3,y5,y10,inception,label,displayLabel}]}`; we take
     `label==="fund"` for the fund's returns and the first `label==="benchmark"` for the primary
     benchmark name (HTML-entity-decoded) + its 1y return. `fund_details` merges all five above +
     the catalog identity row into one row.
   - `/distribution?loadType=initial` → `{distributions:[{exDate, recordDate, payDate,
     distributionAmountPerUnit, ordinaryIncomeDistribution, short/longTermCapitalGainsDistribution,
     returnOfCapitalDistribution}]}`. Backs `distributions` (client-side ex-date range filter).
   - `/navs` (NO variationType) → `{startDate, lineChartData:[{type:"NAV", data:[{date:"MM/DD/YYYY",
     value}]}]}`, daily back to ~inception (10y). Backs `nav_history` (client-side date range).
     UNUSED: `?variationType=nav/historical`, `?variationType=yieldInformation`, and the bare
     shareclass endpoint consistently **503** — do not use them.

**Values:** `num()` strips `$`/`,`/`%`/spaces and parses (Invesco emits `totalExpenseRatio` as a
string but most numbers as real numbers). **Dates:** `dateSec()` accepts BOTH the ISO `YYYY-MM-DD`
most resources use AND the US `MM/DD/YYYY` the navs line chart uses, keeping only the calendar day →
epoch seconds at UTC midnight (validated to reject impossible parts).

**Dates as ARGS:** `distributions` and `nav_history` take `start_date`/`end_date` (real SQL `DATE`;
client-side range filters; named `*_date` because `END` is reserved). The vgi runtime hands a DATE
arg to `p.args` as epoch MILLISECONDS; `dateArgToEpoch` converts it and is magnitude-robust
(epoch-ms, JS Date, bigint, days-since-epoch, or a YYYY-MM-DD string). Omitted/null = unbounded.
Invesco's per-fund URLs carry no date parameter, so this is purely a client-side filter (nav_history
always fetches the full history back to inception and filters).

## Fund identifier (`fund` arg)

`resolveFund(get, fund)`: matches `fund` (case-insensitive) against the cached catalog by ticker OR
by raw CUSIP, returning the fund's `ProductRow` (its CUSIP + identity), or `null` (not a throw —
invesco.ts is SDK-free). `functions.ts` `resolveOrThrow` converts null into an
`ArgumentValidationError` with a "list tickers via products" hint. Every fund-scoped call does one
cached catalog fetch to resolve; the holdings scan resolves in bulk in `onInit`.

## Commands

```bash
bun install
bun test            # unit tests: SDK-free driver + Arrow batch builders + live HTTP-transport E2E
bun run typecheck   # own-source only; scripts/typecheck.sh filters node_modules errors
./run_tests.sh      # haybarn SQLLogic E2E: worker under real DuckDB + community vgi ext
```

`run_tests.sh` sets `VGI_TEST_WORKER=bin/vgi-etf-invesco-worker` + `VGI_WORKER_CATALOG_NAME=invesco`
and runs `test/sql/*.test`. The `.test` files are DESCRIBE-based schema asserts (bind-only → no
network → deterministic) plus a few live-invariant asserts that hit Invesco (fine for an egress
connector). CI runs this, the reusable `ts-ci.yml`, and a `vgi-lint` gate at `--fail-on info`
(currently 100/100).

Typecheck must be a `bash scripts/typecheck.sh` file (not an inline package.json pipeline) —
`bun run` uses Bun's shell, which mishandles the `grep -v node_modules` filter. Pin
`typescript ^6.0.3` (5.x descends into SDK `.ts` source and reports external errors).

## Gotchas / conventions

- Emit `bigint` (not `number`) for `Int64` columns via `batchFromColumns`; date fields go through
  `dateSec()` (→ epoch seconds) then the schema's `dateOrNull`.
- `noUncheckedIndexedAccess` is on: read parallel/array cells carefully (destructured elements type
  as possibly `undefined` and fail the typecheck).
- vgi-lint rules that must stay satisfied: catalog/schema descriptions must NOT enumerate the
  worker's own functions (VGI173 — describe purpose/concepts instead); argument docs must NOT
  restate the data type (VGI313 — the range docs say "ex-day range", never the DATE type); numeric
  column comments should state a unit/definition (VGI131); every function needs an agent test task
  (VGI520 — all are covered in `catalog.ts` `vgi.agent_test_tasks`).
- Don't add a secret type; this worker is keyless by design.
- Don't add time travel to `holdings` — Invesco has no historical as-of. This is the deliberate
  structural difference from vgi-etf-ishares.
- Don't re-add a `sort=` param to `SEARCH_URL` — it 406s the edge WAF (see endpoint facts).

## DuckDB (manual)

```sql
LOAD vgi;
ATTACH 'invesco' AS invesco (TYPE vgi, LOCATION '/path/to/vgi-etf-invesco/bin/vgi-etf-invesco-worker');
SELECT ticker, name, expense_ratio_percent FROM invesco.products ORDER BY expense_ratio_percent LIMIT 10;
SELECT ticker, name, weight_percent FROM invesco.holdings WHERE fund_ticker = 'RSP' ORDER BY weight_percent DESC LIMIT 10;
SELECT as_of_date, nav FROM invesco.nav_history('RSP', start_date := DATE '2025-01-01') ORDER BY as_of_date DESC;
```
