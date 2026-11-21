#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# One entry per crate: "<manifest-dir> <package-dist-dir> <crate-wasm-name>".
CRATES=(
  "packages/router/core packages/router/dist omlx_router_core"
)

for entry in "${CRATES[@]}"; do
  read -r manifest dist name <<<"$entry"
  cargo build \
    --manifest-path "$manifest/Cargo.toml" \
    --target wasm32-unknown-unknown \
    --release \
    --target-dir target

  mkdir -p "$dist"
  cp "target/wasm32-unknown-unknown/release/${name}.wasm" "$dist/core.wasm"

  if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -Oz \
      --enable-bulk-memory \
      --enable-mutable-globals \
      --enable-sign-ext \
      --enable-nontrapping-float-to-int \
      "$dist/core.wasm" -o "$dist/core.wasm"
  fi

  size=$(wc -c < "$dist/core.wasm" | tr -d ' ')
  echo "$dist/core.wasm: ${size} bytes"
done
