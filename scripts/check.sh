#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

cargo fmt --manifest-path core/Cargo.toml -- --check
cargo clippy --manifest-path core/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path core/Cargo.toml
bun run build:wasm
bun test
node scripts/security-check.mjs

size=$(wc -c < dist/core.wasm | tr -d ' ')
limit=614400
if [ "$size" -gt "$limit" ]; then
  echo "dist/core.wasm is ${size} bytes, over the ${limit}-byte limit" >&2
  exit 1
fi
echo "check: ok (${size} bytes)"
