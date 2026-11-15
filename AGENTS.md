# AGENTS.md

Guidance for agents working in this repository.

## What this is

`opencode-omlx-router`: an OpenCode V2 / Kilo plugin that selects the best model
per turn from a user pool using a small oMLX-served judge, plus a deterministic
context optimiser.

## Hard rules

- **No TypeScript application code.** Host adapters, TUI part, CLI, and tests are
  plain ESM JavaScript with JSDoc where useful. The decision engine is Rust
  compiled to `wasm32-unknown-unknown`.
- **The core is pure.** No I/O, clock, randomness, or imports in `core/`.
  Timestamps, pool data, pins, settings, and judge verdicts are passed in; state
  is passed back for the adapter to persist.
- **No wasm-bindgen.** The ABI is explicit (`alloc`, `dealloc`, `route`,
  `optimise`, `result_len`, `abi_version`).
- **Never log prompt text, messages, tool output, or API keys.** Decision records
  store signals and hashes only. See the design spec §13.
- **No network in tests.** Judge calls are mocked.

## VCS

This is a jj repository colocated with git. Use `jj` for all mutations
(`jj st`, `jj describe -m ...`, `jj new`, `jj bookmark set`, `jj git push`),
never `git commit`/`git checkout`/`git reset`. Bookmark `main` is the release
bookmark. Pass `-m` to every describe/commit; never use interactive flags.

## Build and test

```sh
bun run build:wasm     # cargo build --release --target wasm32-unknown-unknown
bun test               # adapter + WASM bridge
bun run test:rust      # cargo test
bun run check          # fmt + clippy + tests + wasm size gate
```

## Design and docs

The design of record is
`docs/specs/2026-11-15-opencode-omlx-router-design.md`. The README is the
user-facing contract and must stay in sync with behaviour. Update both when
behaviour changes.
