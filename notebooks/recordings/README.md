# Recorded official Invesco responses

The three JSON bodies were captured without modification from Invesco's public product API on 2026-11-14 at 06:45:01 UTC. `manifest.json` contains the exact request URL, UTC capture time, response byte count and SHA-256 for each body. No credentials are used. Both holdings bodies report effective date 2026-11-12; that source date is distinct from capture time. Independent HTTP responses are not an atomic snapshot.

The catalog includes the full returned US ETF product page. The two holdings bodies are for RSP (CUSIP 46137V357) and SPHQ (46137V241), including cash, zero and negative lines as returned. Recordings are not synthetic and are not refreshed automatically.

`recorded_worker.ts` verifies each SHA-256 and supplies exact bytes through the released client's existing fetch-injection seam. The real client still constructs requests and caches the catalog; the real worker parses all rows, applies partition filters and emits Arrow data. The adapter does not compute weights, filter holdings or invent missing values. Unknown URLs fail. The notebook audits the exact three requests.

Source: [Invesco](https://www.invesco.com/us). These issuer data are separate from the repository's code license; consult the provider's terms for reuse. No affiliation or endorsement is implied.
