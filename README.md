# vgi-etf-invesco

A [VGI](https://query.farm) worker that exposes **Invesco** US ETF data as DuckDB tables and
table functions — the ETF product catalog, a fund-partitioned holdings table, a wide per-fund
characteristics snapshot, and per-fund distribution and NAV history.

| Object | What it returns | Invesco source |
| --- | --- | --- |
| `invesco.products` (table) | Every US ETF with key facts, one row per fund | `/product/search` catalog |
| `invesco.holdings` (table) | Detailed current holdings, partitioned by fund_ticker | `.../shareclasses/<CUSIP>/holdings/fund` |
| `invesco.fund_details(fund)` | Wide one-row characteristics snapshot | `keyStats` + `fundDetails` + `fundCharacteristics` + `prices` + `performance` |
| `invesco.distributions(fund, start_date, end_date)` | Distribution (dividend / cap-gain) history | `.../shareclasses/<CUSIP>/distribution` |
| `invesco.nav_history(fund, start_date, end_date)` | Daily NAV series back to inception | `.../shareclasses/<CUSIP>/navs` |

Everything rides Invesco's public JSON API on its cache CDN host (`dng-api.invesco.com`) — there
is no secret to create and no login. Funds are identified by their exchange **ticker** (e.g.
`RSP`); Invesco's per-fund resources are keyed by **CUSIP**, so the fund-scoped functions resolve
ticker→CUSIP via one cached catalog lookup.

Two conventions to know:
- **Dates are real `DATE` columns** (no timezone) — compare them directly, e.g.
  `WHERE ex_date >= DATE '2025-01-01'`.
- **Percent columns carry a `_percent` suffix and hold percent points**: `expense_ratio_percent`
  = 0.2 means 0.20%; `weight_percent` = 0.33 means 0.33% (weights sum to ~100). `pe_ratio`,
  `forward_pe_ratio`, and `pb_ratio` are ratios, so they are **not** suffixed.

> **Holdings are current-only.** Invesco publishes a single effective date per fund, so the
> `holdings` table has **no time travel** (unlike some other providers) — the `as_of_date` column
> reflects Invesco's reported effective date.

> **Status:** initial build. Unit tests (SDK-free driver + Arrow batch builders), own-source
> typecheck, a live HTTP-transport smoke test, the haybarn SQLLogic E2E suite against a real
> DuckDB + the community `vgi` extension, and a `vgi-lint` metadata gate at 100/100 all pass.

## Install / attach

### Option A — prebuilt binary (recommended)

Each release ships a self-contained executable per platform, so the host needs **neither Bun nor
`node_modules`**. Archives are named `vgi-etf-invesco-<tag>-<platform>.tar.gz` for `linux_amd64`,
`linux_arm64`, `osx_amd64`, `osx_arm64`, and `windows_amd64`, each with a SHA256, a keyless
**cosign** signature, and a **SLSA** build-provenance attestation.

```bash
tar xzf vgi-etf-invesco-v0.1.0-osx_arm64.tar.gz     # → vgi-etf-invesco-worker
```

```sql
LOAD vgi;
ATTACH 'invesco' AS invesco (TYPE vgi, LOCATION '/path/to/vgi-etf-invesco-worker');
```

### Option B — from source (Bun)

For development or the latest `main`, run the worker on [Bun](https://bun.sh):

```bash
bun install
```

```sql
LOAD vgi;
ATTACH 'invesco' AS invesco (TYPE vgi, LOCATION '/path/to/vgi-etf-invesco/bin/vgi-etf-invesco-worker');
```

`bin/vgi-etf-invesco-worker` is a small wrapper that launches `src/worker.ts` under Bun.

## Usage

### products — the ETF catalog (a base table)

`products` is a plain **table** — no arguments, no parentheses. It returns the whole ETF lineup;
filter with `WHERE`.

```sql
-- Cheapest Invesco ETFs by expense ratio:
SELECT ticker, name, expense_ratio_percent
FROM invesco.products
ORDER BY expense_ratio_percent
LIMIT 10;

-- Fixed-income ETFs:
SELECT ticker, name, expense_ratio_percent
FROM invesco.products
WHERE asset_class = 'Fixed Income'
ORDER BY name;

-- Look up one fund by ticker:
SELECT ticker, name, expense_ratio_percent
FROM invesco.products
WHERE ticker = 'RSP';
```

Filter on `ticker`, `asset_class` (`'Equity'`, `'Fixed Income'`, `'Alternative'`, …),
`investment_method` (`'Passive'`/`'Active'`), etc. Columns include `ticker`, `cusip`, `isin`,
`sedol`, `name`, `asset_class`/`asset_sub_class`/`asset_sub_sub_class`, `investment_method`,
`strategy`, `umbrella`, `distribution_frequency`, `base_currency`, `bloomberg_ticker`, `region`,
`inception_date` (DATE), `expense_ratio_percent`/`net_expense_ratio_percent`, and
`product_page_url`/`factsheet_url`. All `*_percent` columns are in percent points (0.2 = 0.20%).

### holdings — a fund-partitioned table (current-only)

`holdings` is a **table hive-partitioned by `fund_ticker`** (the fund's ticker). Filter
`fund_ticker` to pick funds, or scan without a filter to stream **every** fund's holdings (one
partition per fund — a couple hundred funds, so prefer a filter).

```sql
-- Top 10 current holdings of RSP (already weight-ordered):
SELECT ticker, name, weight_percent, market_value
FROM invesco.holdings
WHERE fund_ticker = 'RSP'
ORDER BY weight_percent DESC
LIMIT 10;

-- Several funds at once (partition fan-out):
SELECT fund_ticker, ticker, weight_percent
FROM invesco.holdings
WHERE fund_ticker IN ('RSP', 'SPHQ');

-- Every fund at once (streams all partitions — slow; each fund is a partition):
SELECT fund_ticker, count(*) AS n
FROM invesco.holdings
GROUP BY fund_ticker;

-- A bond fund also fills coupon / maturity / rating:
SELECT name, coupon_percent, maturity_date, rating, weight_percent
FROM invesco.holdings
WHERE fund_ticker = 'BSCR'
LIMIT 5;
```

`fund_ticker` is the **fund's** ticker and the hive partition key — distinct from the `ticker`
column (each row's own constituent ticker). Invesco reports a single effective date per fund (the
`as_of_date` column); there is **no time travel**. Rows come back **weight-descending**. Join
`holdings.fund_ticker` to `products.ticker` for fund-level facts. Columns: `fund_ticker`,
`as_of_date` (DATE), `name`, `ticker`, `cusip`, `weight_percent`, `market_value`, `units`,
`sec_type`, `currency`, plus the fixed-income-only `coupon_percent`, `maturity_date` (DATE),
`next_call_date` (DATE), and `rating`.

> A backing `holdings_scan()` function is also exposed (it's what the table scans, and it's what
> lets DuckDB push the `fund_ticker` filter) — prefer the `holdings` table.

### fund_details — one-row characteristics snapshot

```sql
SELECT ticker, primary_benchmark, pe_ratio, pb_ratio, expense_ratio_percent, sec_yield_30day_percent
FROM invesco.fund_details('RSP');
```

Adds facts beyond `products`: net assets, holdings count, latest NAV/closing price,
premium/discount, 30-day SEC yield, valuation ratios (P/E, forward P/E, P/B, return on equity,
weighted-average market cap), annualized returns, and the primary benchmark and its return.

```sql
SELECT ticker, net_assets, num_holdings, return_1y_percent, benchmark_return_1y_percent
FROM invesco.fund_details('RSP');
```

### distributions — distribution history

```sql
-- Recent distributions:
SELECT ex_date, amount_per_share, ordinary_income
FROM invesco.distributions('RSP')
ORDER BY ex_date DESC
LIMIT 8;

-- Total distributions since a start date:
SELECT sum(amount_per_share) AS total
FROM invesco.distributions('RSP', start_date := DATE '2025-01-01');
```

Amounts are **per-share dollars**, not percentages, with the ordinary-income / capital-gain /
return-of-capital breakdown. `start_date`/`end_date` bound the ex-date range (inclusive SQL
`DATE`s; omit for unbounded).

### nav_history — daily NAV series

```sql
-- Daily NAV since a start date:
SELECT as_of_date, nav
FROM invesco.nav_history('RSP', start_date := DATE '2025-01-01')
ORDER BY as_of_date DESC;

-- NAV range over a bounded window:
SELECT min(nav), max(nav)
FROM invesco.nav_history('RSP', start_date := DATE '2025-01-01', end_date := DATE '2025-12-31');
```

Daily NAV back to inception, one row per valuation day. `start_date`/`end_date` bound the range
(inclusive SQL `DATE`s; omit for the full history). This is **fund NAV**, not an intraday candle
series.

## Development

```bash
bun install
bun test            # unit tests (SDK-free driver + Arrow batch builders + live HTTP transport)
bun run typecheck   # own-source typecheck (see scripts/typecheck.sh)
./run_tests.sh      # haybarn SQLLogic E2E under a real DuckDB + the community vgi extension
```

The E2E suite needs the haybarn runner and the vgi extension, once:

```bash
uv tool install haybarn-unittest
echo "INSTALL vgi FROM community;" | uvx haybarn-cli
```

Metadata quality is graded by [`vgi-lint`](https://github.com/Query-farm/vgi-lint-check); CI runs
it as a gate at 100/100. Locally:

```bash
uvx --prerelease allow --from vgi-lint-check vgi-lint bin/vgi-etf-invesco-worker --fail-on info
```

The pure request/response logic lives in `src/invesco.ts` and is fully unit-tested against an
in-process fake (`test/fake-invesco.ts`) — no network. The single module that touches the network
is `src/client.ts` (it sets the browser-like User-Agent + Referer Invesco requires and retries the
edge's transient 503s); it is verified live rather than in the unit suite.

## Layout

```
src/invesco.ts    Pure driver: URL builders + JSON parsers + fetch orchestrators (no network, no SDK)
src/client.ts     Real fetch client (browser User-Agent + Referer; 5xx retry; keyless)
src/schema.ts     Typed Arrow output schemas + row→batch builders
src/functions.ts  The table-function / backing-scan definitions
src/catalog.ts    The `invesco` catalog descriptor (no secret type)
src/worker.ts     Worker entry: wires the real client into the functions
bin/…-worker      Launch wrapper (bun run src/worker.ts) for DuckDB ATTACH
```

## Data source & terms

Data comes from Invesco's public product API (`dng-api.invesco.com`: the `/product/search` catalog
and the per-fund `/cache/v1/.../shareclasses/<CUSIP>/…` resources). It is provided for personal,
informational use; consult Invesco's terms before any redistribution or commercial use. This worker
is not affiliated with or endorsed by Invesco Ltd.

## License

MIT — Copyright 2026 Query Farm LLC · https://query.farm
