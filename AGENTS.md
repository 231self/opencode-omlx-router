# AGENTS.md

Guidance for agents working in this repository.

## What this is

`opencode-router`: an OpenCode V2 / Kilo plugin that selects the best model
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
bun run check          # fmt + clippy + tests + wasm size gate + security gate
bun run security       # secret scan of the tree and the published tarball
```

Live-only checks (need oMLX and provider keys): `bun run test:e2e`,
`bun run test:e2e:live`, `bun run judge:calibrate --repeat 3` (writes the
verdict-noise band), `bun run routing:eval`, `bun run quality:eval`.

## Releasing

Publishing happens from CI on a GitHub Release, over npm trusted publishing
(OIDC). Never publish manually and never commit an npm token.

1. Bump the version in `package.json`, `src/version.js`, `core/Cargo.toml` +
   `core/Cargo.lock`, `tests/status.test.js`, the README status line, and
   `docs/releasing.md`. Add the `CHANGELOG.md` section for the version.
2. `bun run check`, commit, push `main`, and wait for `ci` and `security` to
   pass.
3. `jj tag set vX.Y.Z -r main` and `jj git push --tag vX.Y.Z`.
4. Create the GitHub Release with notes extracted from the changelog section.
   Publishing the release triggers `.github/workflows/release.yml`, which
   re-runs `bun run check`, verifies the tag against the package and changelog,
   and runs `npm stage publish --access public`. A red check stops it; nothing
   reaches the registry yet.
5. Approve the staged version with 2FA: `npm stage list`, then
   `npm stage approve <stage-id>` (or npmjs.com → Staged Packages → Approve).
   The first publish after creating a trusted-publisher config must be approved
   within 2 days or the config expires; re-create it if that happens.

The full runbook, including verification and rollback, is
`docs/releasing.md`.

## Design and docs

The design of record is
`docs/specs/2026-11-15-opencode-omlx-router-design.md`. The README is the
user-facing contract and must stay in sync with behaviour. Update both when
behaviour changes.
