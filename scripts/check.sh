#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# One entry per Rust crate; keep in sync with scripts/build-wasm.sh.
CRATES=(packages/router/core packages/compaction/core)

for crate in "${CRATES[@]}"; do
  cargo fmt --manifest-path "$crate/Cargo.toml" -- --check
  cargo clippy --manifest-path "$crate/Cargo.toml" --all-targets -- -D warnings
  cargo test --manifest-path "$crate/Cargo.toml"
done

bun run build:wasm
bun test
node scripts/security-check.mjs

limit=614400
for wasm in packages/*/dist/core.wasm; do
  size=$(wc -c < "$wasm" | tr -d ' ')
  if [ "$size" -gt "$limit" ]; then
    echo "$wasm is ${size} bytes, over the ${limit}-byte limit" >&2
    exit 1
  fi
  echo "size gate ok: $wasm (${size} bytes, limit ${limit})"
done
echo "check: ok"
