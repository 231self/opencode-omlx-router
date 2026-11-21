# Changelog

## 0.1.0 — 2026-11-21

### Added

- Initial extraction of the shared runtime from `@231self/opencode-router`:
  pricing and measurement (`cost.js`: `normaliseCost`, `tiersOf`, `mergeCost`,
  `costSource`, `modelledTurnCost`; `tokens.js`: `estimateTokens`, `partTokens`,
  `countContextTokens`, `measureSessionContext`, `cacheHitShare` — semantics
  unchanged, with their recorded-cost validation fixtures), and the host
  adapters (`config.js`, `state.js`) covering the `OMLX_ROUTER_*` env vars,
  the config schema with `{env:}` placeholder handling, and the
  `~/.local/state/omlx-router/` state paths.
