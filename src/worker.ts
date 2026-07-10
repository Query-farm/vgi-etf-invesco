// vgi-etf-invesco stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'invesco' AS iv (TYPE vgi, LOCATION '/path/to/vgi-etf-invesco/bin/vgi-etf-invesco-worker');
//   SELECT * FROM iv.products ORDER BY expense_ratio_percent LIMIT 10;
//   SELECT * FROM iv.holdings WHERE fund_ticker = 'RSP';
//   SELECT * FROM iv.nav_history('RSP', start_date := DATE '2025-01-01');
//
// What this worker serves is defined once in src/parts.ts and shared with the
// HTTP entrypoint (scripts/serve.ts).

import { Worker } from "@query-farm/vgi";
import { makeWorkerParts } from "./parts.js";

const { servedFunctions, catalogInterface } = makeWorkerParts();

// `functions` for the Worker is the full set the registry serves (incl. the table scans).
new Worker({ functions: servedFunctions, catalogInterface }).run();
