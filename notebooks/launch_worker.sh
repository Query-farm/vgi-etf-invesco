#!/usr/bin/env bash
# Fetch unchanged released domain functions; notebook adapter selects transport.
set -euo pipefail
notebook_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
worker_revision="5499075446387d043271e4bffd04a3d1fd56b44f"
worker_source="$notebook_dir/artifacts/worker-$worker_revision"
worker_lock="$notebook_dir/artifacts/worker-$worker_revision.lock"
mkdir -p "$notebook_dir/artifacts"
# VGI may start multiple workers together. Serialize cache creation/install.
lock_acquired=false
for ((attempt=0; attempt<600; attempt++)); do
  if mkdir "$worker_lock" 2>/dev/null; then lock_acquired=true; break; fi
  sleep 0.1
done
if [[ "$lock_acquired" != true ]]; then
  echo "Worker cache lock timed out; ensure no launcher is active before removing $worker_lock" >&2
  exit 1
fi
trap 'rmdir "$worker_lock" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ ! -d "$worker_source/.git" ]]; then
  git clone --no-checkout https://github.com/Query-farm/vgi-etf-invesco.git "$worker_source" >&2
  git -C "$worker_source" checkout --detach "$worker_revision" >&2
fi
if [[ "$(git -C "$worker_source" rev-parse HEAD)" != "$worker_revision" ]]; then
  echo "Worker cache revision differs from its pin; use a fresh artifacts directory." >&2
  exit 1
fi
git -C "$worker_source" diff --quiet HEAD -- src package.json bun.lock || {
  echo "Worker cache source was modified; use a fresh artifacts directory." >&2
  exit 1
}
if [[ ! -f "$worker_source/.notebook-installed" || ! -d "$worker_source/node_modules" ]]; then
  (cd "$worker_source" && bun install --frozen-lockfile) >&2
  touch "$worker_source/.notebook-installed"
fi
cp "$notebook_dir/recorded_worker.ts" "$worker_source/_notebook_recorded_worker.ts.tmp.$$"
mv "$worker_source/_notebook_recorded_worker.ts.tmp.$$" "$worker_source/_notebook_recorded_worker.ts"
rmdir "$worker_lock"
trap - EXIT INT TERM
exec bun run "$worker_source/_notebook_recorded_worker.ts"
