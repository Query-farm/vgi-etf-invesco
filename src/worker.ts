// vgi-etf-invesco stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'invesco' AS invesco (TYPE vgi, LOCATION '/path/to/vgi-etf-invesco/bin/vgi-etf-invesco-worker');
//
// What this worker serves is defined once in src/parts.ts and shared with the
// HTTP entrypoint (scripts/serve.ts).

import { Worker } from "@query-farm/vgi";
import { makeWorkerParts } from "./parts.js";

const { servedFunctions, catalogInterface } = makeWorkerParts();

new Worker({ functions: servedFunctions, catalogInterface }).run();
