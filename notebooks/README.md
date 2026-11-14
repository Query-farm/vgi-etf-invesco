# Executed Invesco holdings walkthrough

[Where does the reported holdings weight sit?](01_measure_holdings_concentration.ipynb) retrieves only RSP and SPHQ, separates positive/zero/negative/missing weights, and compares largest-row weight with the complete positive-weight distribution. SQL derives all calculations through Haybarn and the real VGI worker. This is descriptive analysis, not investment advice or a measure of independent economic risks.

## Install and run

Prerequisites: [uv](https://docs.astral.sh/uv/), [Bun](https://bun.sh/), Git, Python 3.13 or 3.14 and network access on first launch. No account or API key is needed. Copy this entire directory to use it without the repository source.

```sh
cd notebooks
uv sync --frozen
uv run --frozen python execute.py --timeout 180
```

The notebook environment pins published Haybarn `2.0.0rc11` and its own dependency lock. The runner uses its own interpreter and a temporary kernel, notebook-directory working directory, and atomic save after success. Failures preserve the last successful example. It does not discover a root `.venv` or local worker source.

For an interactive editor, register and select this environment:

```sh
uv run --frozen python -m ipykernel install --user --name vgi-invesco-notebooks --display-name 'Python (Invesco notebooks)'
```

Keep the working directory at `notebooks/`. Python support and plots are folded; parameters and SQL remain visible. Branding uses unchanged official local assets.

## Parameters and separate experiments

`TOP_N=10` counts positive-weight holding rows per fund; allowed integer range is 1–100, further checked against the actual row counts. Rows are not consolidated issuers. Change only this to 25 for the focused experiment:

```sh
uv run --frozen python execute.py --timeout 180 --parameters '{"TOP_N":25}' --output-dir artifacts/top-25
```

Reset `TOP_N = 10` for the default. Overrides require a separate destination; the runner copies images, recordings, helper, launcher, transport adapter, environment files and this README into successful experiment directories. Generated caches, logs, chart extracts and experiment copies are ignored.

`DATA_MODE="recorded"` serves exact official response bytes captured 2026-11-14 at 06:45:01 UTC; both funds report effective date 2026-11-12. `DATA_MODE="live"` calls the same issuer endpoints for their current values, with dynamic source-date and mode labels. There is no historical date parameter and no replay fallback after live failure.

```sh
uv run --frozen python execute.py --timeout 180 --parameters '{"DATA_MODE":"live"}' --output-dir artifacts/live
```

Live requests are read-only and bounded to the catalog and two funds. Independent responses may have different effective dates and are not an atomic snapshot. The worker may skip failed holdings partitions; the notebook rejects a missing or empty requested fund instead of presenting it as zero.

## Portable released-worker launch

The visible SQL is literal:

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'invesco' (TYPE vgi, LOCATION 'bash launch_worker.sh');
```

`launch_worker.sh` fetches `https://github.com/Query-farm/vgi-etf-invesco` at immutable release revision `5499075446387d043271e4bffd04a3d1fd56b44f` (`v0.4.0`), verifies the cached revision and tracked source, and installs its frozen `bun.lock`. Cache setup is serialized because VGI may start multiple processes concurrently; later starts reuse the completed install. Bun 1.3.14 was used for validation. It copies only the local adapter into that ignored cache. No engine is built. The published native `github-auto://Query-farm/vgi-etf-invesco@v0.4.0` was also verified through Haybarn; this notebook uses the source launcher so the same released functions can consume recorded or live transport.

The adapter wires existing function factories and catalog with `makeInvescoGet`. In recorded mode its injected fetch checks the manifest hashes, matches exact URLs and returns saved bytes; the client still constructs requests and memoizes the catalog. The worker still performs all parsing, partition pushdown and Arrow output. The adapter does not filter holdings or calculate results. Unknown requests fail. The default checks an exact three-request audit. In live mode the normal client uses official HTTPS directly. Configuration comes only from the visible mode and notebook-managed environment variables, restored at cleanup.

See [recording provenance](recordings/README.md) and [manifest](recordings/manifest.json) for URLs, UTC times, byte counts and SHA-256 hashes. These are real public responses, not generated portfolio examples. Issuer data remain separate from the code license; consult Invesco's terms for reuse. No affiliation is implied.

To upgrade, choose an available release, update the explicit revision and frozen source, then recheck both modes, default and experiment. Changing a package tag is not evidence that new output is compatible.

## Units and interpretation

`weight_percent=0.33` means 0.33 percentage points of reported net assets. The notebook does not force the sum to 100. Positive and negative reported weights reconcile to the known net total; missing and zero weights are shown separately. Concentration is conditional on the known positive subset: `p_i=w_i/sum(w_i)` there, index `H=sum(p_i^2)`, and effective equal-weight row count `1/H`. None of these consolidates duplicate issuers, derivative exposures or economic correlations. The curve's equal-weight diagonal is a mathematical reference, not another fund or return benchmark.

Changing N selects a different prefix of the same ranked rows. Largest-N reported weight and its share of the positive subset use distinct denominators. Source dates are SQL DATEs without timezones; execution and capture clocks use UTC. Assertions use tolerances for floating-point sums and do not require net weights to equal 100 or a particular fund ranking.

## Validation

Verified through published Haybarn on macOS arm64:

- Default, `TOP_N=25` experiment and full live mode pass from a copied notebooks-only directory. Final runs took 2.4 s, 2.4 s and 2.5 s after the cold launcher check. Each has 13 code cells, six SQL cells, two charts and ten SQL invariants. All six rendered charts were reviewed.
- Recorded source coverage: RSP 511 rows, including 506 positive / 2 negative / 2 zero / 1 missing-weight; SPHQ 105 rows, including 101 positive / 2 negative / 1 zero / 1 missing-weight. Both dates are 2026-11-12. The exact three-request replay audit passes.
- Largest 10→25 rows: RSP 2.69→6.31 reported net-asset percentage points; SPHQ 44.20→70.11. Positive totals, whole curves and effective row counts (494.0 / 35.7) stay fixed. Live validation returned the same source dates and values at its run time; future runs can differ.
- Three runner guards pass without overwriting the successful default. All three notebooks pass the structural checker; Ruff lint/format and shell syntax checks pass. Official image assets are unchanged.
- Current source gates, separate from the pinned release: 51 Bun tests / 181 expectations, own-source TypeScript check, 28 SQL assertions in three cases, and metadata 100 L2 with zero findings at fail-on-info. Unit coverage includes a live HTTP product scan. Metadata execution was enabled; external-link and paid AI passes were disabled. Root source and `bun.lock` are unchanged.

Raw logs, charts and executed experiment/live copies are under ignored `artifacts/`.
