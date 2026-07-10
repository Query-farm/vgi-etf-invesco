// Single source of truth for what this worker serves.
//
// Both entrypoints consume this: `src/worker.ts` (stdio, spawned by DuckDB) and
// `scripts/serve.ts` (HTTP). They used to build the registry and catalog
// separately, so adding a function meant remembering to register it twice —
// miss one and the HTTP transport quietly serves a stale catalog.

import { FunctionRegistry, ReadOnlyCatalogInterface } from "@query-farm/vgi";
import { makeInvescoGet } from "./client.js";
import {
  makeProductsScan,
  makeHoldingsScan,
  makeFundDetailsFunction,
  makeDistributionsFunction,
  makeNavHistoryFunction,
} from "./functions.js";
import { makeCatalog } from "./catalog.js";

export function makeWorkerParts() {
  const get = makeInvescoGet();

  // The callable table functions (products and holdings are base tables, not functions).
  const functions = [
    makeFundDetailsFunction(get),
    makeDistributionsFunction(get),
    makeNavHistoryFunction(get),
  ];

  // Backing scans for the base tables: registered so scan RPCs resolve. products' scan stays
  // unlisted (exposed only as the `products` table); holdings' scan is LISTED (in makeCatalog)
  // so the extension can push the fund_ticker filter into the `holdings` table.
  const productsScan = makeProductsScan(get);
  const holdingsScan = makeHoldingsScan(get);

  const registry = new FunctionRegistry();
  for (const fn of functions) registry.register(fn);
  registry.register(productsScan);
  registry.register(holdingsScan);

  const catalogInterface = new ReadOnlyCatalogInterface(
    makeCatalog(functions, productsScan, holdingsScan),
    registry,
  );

  return {
    registry,
    catalogInterface,
    /** Everything the registry serves, including the table-backing scans. */
    servedFunctions: [...functions, productsScan, holdingsScan],
  };
}
