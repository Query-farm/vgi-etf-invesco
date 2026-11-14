/** Existing Invesco function factories, with recorded or official HTTP transport.
 * Parsing, partition pushdown, catalog and Arrow output are unchanged remote code.
 */
import { FunctionRegistry, ReadOnlyCatalogInterface, Worker } from '@query-farm/vgi';
import { makeInvescoGet } from './src/client.ts';
import { makeProductsScan, makeHoldingsScan, makeFundDetailsFunction,
  makeDistributionsFunction, makeNavHistoryFunction } from './src/functions.ts';
import { makeCatalog } from './src/catalog.ts';
import { readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const mode = process.env.NOTEBOOK_INVESCO_DATA_MODE;
if (mode !== 'recorded' && mode !== 'live') throw Error('Choose recorded or live in the notebook');
let get;
if (mode === 'live') {
  get = makeInvescoGet();
} else {
  const directory = process.env.NOTEBOOK_INVESCO_RECORDINGS;
  const audit = process.env.NOTEBOOK_INVESCO_AUDIT;
  if (!directory || !audit) throw Error('Notebook recording paths are required');
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  const responses = new Map<string, Buffer>();
  for (const record of manifest.records) {
    const bytes = readFileSync(join(directory, record.file));
    if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw Error('Recording hash mismatch');
    responses.set(record.url, bytes);
  }
  get = makeInvescoGet(async (input, init) => {
    const url = String(input);
    if (init?.method && init.method !== 'GET') throw Error('Read-only recordings accept GET');
    const bytes = responses.get(url);
    if (!bytes) throw Error(`Unrecorded request: ${url}`);
    appendFileSync(audit, JSON.stringify({url}) + '\n');
    return new Response(bytes, {status: 200, headers: {'Content-Type': 'application/json'}});
  });
}
const functions = [makeFundDetailsFunction(get), makeDistributionsFunction(get), makeNavHistoryFunction(get)];
const products = makeProductsScan(get);
const holdings = makeHoldingsScan(get);
const registry = new FunctionRegistry();
for (const fn of [...functions, products, holdings]) registry.register(fn);
const catalogInterface = new ReadOnlyCatalogInterface(makeCatalog(functions, products, holdings), registry);
new Worker({functions: [...functions, products, holdings], catalogInterface}).run();
