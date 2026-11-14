// Composed example queries: each combines two of the worker's objects in one query. Defined once
// here and referenced from both the schema-level example list (catalog.ts) and the example list of
// the object that drives the query (catalog.ts table tags / functions.ts), so the SQL never drifts.

export interface ExampleQuery {
  description: string;
  sql: string;
}

/** products ⋈ holdings: screen the catalog, then look one stock up across the matching funds. */
export const EQUAL_WEIGHT_NVDA_EXPOSURE: ExampleQuery = {
  description:
    "Which S&P 500 Equal Weight funds hold NVIDIA, and at what weight: screen products by strategy, " +
    "then join to holdings (the ticker filter is pushed into the holdings scan; the join itself is " +
    "not, so every fund's holdings are read once)",
  sql:
    "SELECT p.ticker, p.name, h.weight_percent FROM invesco.main.products p JOIN invesco.main.holdings h " +
    "ON h.fund_ticker = p.ticker WHERE p.strategy LIKE 'IDXEQ - S&P 500 Equal Weight%' AND h.ticker = 'NVDA' " +
    "ORDER BY h.weight_percent DESC",
};

/** holdings ⋈ holdings: the classic portfolio-overlap metric between two funds. */
export const QQQ_RSP_OVERLAP: ExampleQuery = {
  description:
    "Portfolio overlap of QQQ and RSP: how many holdings they share (matched by CUSIP) and the " +
    "overlap percent, the sum over shared holdings of the smaller of the two weights",
  sql:
    "SELECT count(*) AS shared_holdings, round(sum(least(q.weight_percent, r.weight_percent)), 2) AS overlap_percent " +
    "FROM invesco.main.holdings q JOIN invesco.main.holdings r ON r.cusip = q.cusip " +
    "WHERE q.fund_ticker = 'QQQ' AND r.fund_ticker = 'RSP'",
};

/** distributions + fund_details: trailing-12-month distribution yield next to the 30-day SEC yield. */
export const RSP_TTM_YIELD_VS_SEC: ExampleQuery = {
  description:
    "RSP's trailing-12-month distribution yield (per-share distributions over the last year divided " +
    "by the latest NAV) next to its 30-day SEC yield",
  sql:
    "WITH d AS (SELECT sum(amount_per_share) AS ttm_per_share FROM invesco.main.distributions('RSP', " +
    "start_date := CAST(current_date - INTERVAL 1 YEAR AS DATE))) " +
    "SELECT f.ticker, round(100 * d.ttm_per_share / f.nav, 2) AS ttm_distribution_yield_percent, " +
    "f.sec_yield_30day_percent FROM invesco.main.fund_details('RSP') f CROSS JOIN d",
};

/** nav_history + distributions: a calendar-year total return built from NAV change plus payouts. */
export const RSP_2025_TOTAL_RETURN: ExampleQuery = {
  description:
    "RSP's 2025 NAV total return without reinvestment: the NAV change from 2024-12-31 to 2025-12-31 " +
    "plus the per-share distributions with a 2025 ex-date, as a percent of the starting NAV",
  sql:
    "WITH n AS (SELECT arg_min(nav, as_of_date) AS start_nav, arg_max(nav, as_of_date) AS end_nav " +
    "FROM invesco.main.nav_history('RSP', start_date := DATE '2024-12-31', end_date := DATE '2025-12-31')), " +
    "d AS (SELECT sum(amount_per_share) AS paid FROM invesco.main.distributions('RSP', " +
    "start_date := DATE '2025-01-01', end_date := DATE '2025-12-31')) " +
    "SELECT round(100 * (end_nav / start_nav - 1), 2) AS nav_change_percent, " +
    "round(100 * paid / start_nav, 2) AS distributions_percent, " +
    "round(100 * ((end_nav + paid) / start_nav - 1), 2) AS total_return_percent FROM n CROSS JOIN d",
};
