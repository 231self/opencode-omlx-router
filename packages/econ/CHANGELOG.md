# Changelog

## 0.1.0 — 2026-11-21

### Added

- Initial extraction of the shared pricing library from `@231self/opencode-router`:
  cost-shape normalisation (`normaliseCost`, `tiersOf`, `mergeCost`,
  `costSource`), `modelledTurnCost`, token measurement (`estimateTokens`,
  `partTokens`, `countContextTokens`, `measureSessionContext`), and
  `cacheHitShare` — semantics unchanged, with their recorded-cost validation
  fixtures (a recorded turn reconciling exactly to $0.028712).
