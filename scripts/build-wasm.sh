#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build \
  --manifest-path core/Cargo.toml \
  --target wasm32-unknown-unknown \
  --release \
  --target-dir target

mkdir -p dist
cp target/wasm32-unknown-unknown/release/omlx_router_core.wasm dist/core.wasm

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz dist/core.wasm -o dist/core.wasm
fi

size=$(wc -c < dist/core.wasm | tr -d ' ')
echo "dist/core.wasm: ${size} bytes"
