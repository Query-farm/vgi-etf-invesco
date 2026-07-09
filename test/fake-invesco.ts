// A tiny in-process fake of the Invesco endpoints — enough to prove the driver: it records every
// requested URL (so a test can assert the wire contract) and returns canned envelopes shaped like
// the real /product/search catalog JSON and the per-fund cache resources. No network. Matches the
// driver's injected `get(url) => Promise<unknown>` signature. The fixtures mirror the real response
// shapes observed live (search / holdings / keyStats / fundDetails / fundCharacteristics / prices /
// performance / distribution / navs).

export class FakeInvesco {
  /** Every URL this fake was asked for, in order. */
  readonly calls: string[] = [];

  constructor(private readonly responder: (url: string) => unknown) {}

  get = async (url: string): Promise<unknown> => {
    this.calls.push(url);
    return this.responder(url);
  };

  /** Route by URL: the catalog vs each per-fund cache resource. */
  static router(routes: {
    catalog?: unknown;
    holdings?: unknown;
    keyStats?: unknown;
    fundDetails?: unknown;
    characteristics?: unknown;
    prices?: unknown;
    performance?: unknown;
    distribution?: unknown;
    navs?: unknown;
  }): FakeInvesco {
    return new FakeInvesco((url) => {
      if (url.includes("/product/search")) return routes.catalog ?? {};
      if (url.includes("/holdings/fund")) return routes.holdings ?? {};
      if (url.includes("/keyStats")) return routes.keyStats ?? {};
      if (url.includes("variationType=fundDetails")) return routes.fundDetails ?? {};
      if (url.includes("variationType=fundCharacteristics")) return routes.characteristics ?? {};
      if (url.includes("/prices")) return routes.prices ?? {};
      if (url.includes("/performance/standard")) return routes.performance ?? {};
      if (url.includes("/distribution")) return routes.distribution ?? {};
      if (url.includes("/navs")) return routes.navs ?? {};
      return {};
    });
  }
}

// ── /product/search catalog ─────────────────────────────────────────────────────

/** A catalog Solr doc (as nested in response.docs). */
function catalogDoc(opts: {
  ticker: string;
  cusip: string;
  isin: string;
  name: string;
  assetClass: string;
  assetSubClass?: string;
  expense: string;
  strategy?: string;
  method?: string;
}): Record<string, unknown> {
  return {
    ticker: opts.ticker,
    cusip: opts.cusip,
    isin: opts.isin,
    sedol: "BZ03230",
    accountName: opts.name,
    title: `${opts.name}®`,
    assetClass: opts.assetClass,
    assetSubClass: opts.assetSubClass ?? "U.S. Equity",
    assetSubSubClass: "U.S. Core Equity",
    investmentMethod: opts.method ?? "Passive",
    strategy: opts.strategy ?? "IDXEQ - S&P 500 Equal Weight",
    umbrella: "Invesco Exchange-Traded Fund Trust",
    distributionFrequency: "Quarterly",
    baseCurrency: "USD",
    bloombergTicker: "SPXEWTR",
    region: "United States",
    inceptionDate: "2003-04-24",
    totalExpenseRatio: opts.expense,
    netExpenseRatio: opts.expense,
    uniqueIdentifier: "cusip",
    url: "/content/invesco/us/en/financial-products/etfs/invesco-sp-500-equal-weight-etf.html",
    factsheet: "/content/dam/invesco/us/en/product-documents/etf/fact-sheet/rsp.pdf",
  };
}

/** A catalog envelope with one equity ETF (RSP) and one fixed-income ETF (BSCR). */
export function catalogEnvelope(): Record<string, unknown> {
  return {
    responseHeader: { status: 0 },
    response: {
      numFound: 2,
      docs: [
        catalogDoc({
          ticker: "RSP",
          cusip: "46137V357",
          isin: "US46137V3574",
          name: "Invesco S&P 500 Equal Weight ETF",
          assetClass: "Equity",
          expense: "0.2",
        }),
        catalogDoc({
          ticker: "BSCR",
          cusip: "46138J783",
          isin: "US46138J7834",
          name: "Invesco BulletShares 2027 Corporate Bond ETF",
          assetClass: "Fixed Income",
          assetSubClass: "Target Maturity",
          expense: "0.1",
          method: "Passive",
          strategy: "Nasdaq BulletShares 2027 Corporate Bond",
        }),
      ],
    },
  };
}

// ── per-fund cache resources ─────────────────────────────────────────────────────

/** A /holdings/fund envelope with two equity constituents (one carrying a blank cusip). */
export function equityHoldingsEnvelope(): unknown {
  return {
    cusip: "46137V357",
    effectiveDate: "2026-07-07",
    effectiveBusinessDate: "2026-07-07",
    totalNumberOfHoldings: 2,
    holdings: [
      {
        ticker: "MRNA",
        issuerName: "Moderna Inc",
        units: 4053817,
        percentageOfTotalNetAssets: 0.333568,
        securityTypeName: "Common Stock",
        coupon: null,
        maturityDate: null,
        spMoodysRating: "NR/NR",
        marketValueBase: 323372982.09,
        cusip: "60770K107",
        currency: "USD",
        securityTypeCode: "COM",
      },
      {
        ticker: "AAPL",
        issuerName: "Apple Inc",
        units: 1000000,
        percentageOfTotalNetAssets: 0.21,
        securityTypeName: "Common Stock",
        coupon: null,
        maturityDate: null,
        spMoodysRating: "NR/NR",
        marketValueBase: 210000000,
        cusip: "", // blank → null
        currency: "USD",
        securityTypeCode: "COM",
      },
    ],
  };
}

/** A /holdings/fund envelope: same shape plus coupon / maturityDate / nextCallDate / rating. */
export function bondHoldingsEnvelope(): unknown {
  return {
    cusip: "46138J783",
    effectiveDate: "2026-07-07",
    totalNumberOfHoldings: 2,
    holdings: [
      {
        ticker: "MSFT",
        issuerName: "Microsoft Corp",
        units: 41053000,
        percentageOfTotalNetAssets: 0.901457,
        securityTypeName: "Corporate Bond",
        coupon: 3.3,
        maturityDate: "2027-02-06",
        nextCallDate: "2026-11-06",
        spMoodysRating: "AAA/Aaa",
        marketValueBase: 40831499.36,
        cusip: "594918BY9",
        currency: "USD",
        securityTypeCode: "CB",
      },
      {
        ticker: "AAPL",
        issuerName: "Apple Inc",
        units: 20000000,
        percentageOfTotalNetAssets: 0.5,
        securityTypeName: "Corporate Bond",
        coupon: 2.4,
        maturityDate: "2027-05-11",
        nextCallDate: null,
        spMoodysRating: "AA+/Aaa",
        marketValueBase: 20000000,
        cusip: "037833EB2",
        currency: "USD",
        securityTypeCode: "CB",
      },
    ],
  };
}

/** A /keyStats envelope. */
export function keyStatsEnvelope(): unknown {
  return {
    cusip: "46137V357",
    currency: "USD",
    keyStats: [
      { name: "ytd", value: 12.033712, asOfDate: "2026-06-30" },
      { name: "secYield30Day", value: 1.515612, asOfDate: "2026-07-07" },
    ],
  };
}

/** A base shareclass envelope for variationType=fundDetails (net assets / holdings count). */
export function fundDetailsEnvelope(): unknown {
  return {
    cusip: "46137V357",
    effectiveDate: "2026-06-23",
    currencyCode: "USD",
    totalNoOfHoldings: 505,
    shareclassTotalNetAssets: 90125734054.26,
  };
}

/** A base shareclass envelope for variationType=fundCharacteristics (valuation ratios). */
export function characteristicsEnvelope(): unknown {
  return {
    cusip: "46137V357",
    effectiveDate: "2026-06-30",
    currencyCode: "USD",
    priceToEarningsRatio: 21.067522,
    forwardPriceToEarningsRatio: 16.902337,
    priceToBookRatio: 3.338811,
    returnOnEquity: 18.547836,
    weightedAverageMarketCapatilization: 138342079160,
  };
}

/** A /prices?variationType=priceListing envelope (nav, closing price, prem/disc, volume). */
export function pricesEnvelope(): unknown {
  return {
    effectiveDate: "2026-07-07",
    cusip: "46137V357",
    currency: "USD",
    nav: 203.677982,
    sharesOutstanding: 428892663,
    "30dayAverageTradingVolume": 8859930,
    closingPrice: 203.66,
    medianBidAskSpread: 0,
    bidAskMidpointPremiumDiscountPercentage: 0.005901,
  };
}

/** A /performance/standard envelope (annualized fund + benchmark returns). */
export function performanceEnvelope(): unknown {
  return {
    effectiveDate: "2026-05-31",
    cusip: "46137V357",
    currencyCode: "USD",
    annualizedPerformance: [
      { ytd: 9.46, y1: 20.22848, y3: 16.237043, y5: 8.452255, y10: 11.857879, inception: 11.262739, label: "fund", displayLabel: "Fund NAV" },
      { ytd: 9.48, y1: 20.25728, y3: 16.22572, y5: 8.421214, y10: 11.866647, inception: 11.263892, label: "marketPrice", displayLabel: "Fund market price" },
      { ytd: 9.53, y1: 20.431386, y3: 16.485861, y5: 8.661365, y10: 12.091892, inception: 11.686778, label: "benchmark", displayLabel: "S&amp;P 500 Equal Weight Index" },
    ],
  };
}

/** A /distribution envelope (distributions[]). */
export function distributionEnvelope(): unknown {
  return {
    cusip: "46137V357",
    currencyCode: "USD",
    distributions: [
      {
        exDate: "2026-06-22",
        recordDate: "2026-06-22",
        payDate: "2026-06-26",
        distributionAmountPerUnit: 0.81014,
        ordinaryIncomeDistribution: 0.81014,
        shortTermCapitalGainsDistribution: null,
        longTermCapitalGainsDistribution: null,
        returnOfCapitalDistribution: null,
      },
      {
        exDate: "2026-03-23",
        recordDate: "2026-03-23",
        payDate: "2026-03-27",
        distributionAmountPerUnit: 0.81151,
        ordinaryIncomeDistribution: 0.81151,
        shortTermCapitalGainsDistribution: null,
        longTermCapitalGainsDistribution: null,
        returnOfCapitalDistribution: null,
      },
    ],
  };
}

/** A /navs envelope: the NAV line-chart series (dates in MM/DD/YYYY). */
export function navsEnvelope(): unknown {
  return {
    cusip: "46137V357",
    startDate: "2016-06-08",
    currency: "USD",
    lineChartData: [
      {
        type: "NAV",
        label: "NAV",
        data: [
          { date: "07/07/2026", value: 214.742261 },
          { date: "07/06/2026", value: 215.006679 },
          { date: "01/02/2025", value: 180.5 },
        ],
      },
    ],
  };
}
