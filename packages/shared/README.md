# @231self/opencode-shared

Shared runtime for
[`@231self/opencode-router`](https://www.npmjs.com/package/@231self/opencode-router)
and `@231self/opencode-compaction`. Plain ESM, no npm dependencies.

- `cost.js` — normalises every cost shape seen in the wild (OpenCode V2
  catalog, models.dev, V2 client) into per-million-token tier prices
  (`normaliseCost`, `tiersOf`, `mergeCost`, `costSource`) and models a turn's
  cost with a measured cache-hit share (`modelledTurnCost`). Missing prices
  stay `undefined` so displays say "unknown" instead of inventing `$0`.
- `tokens.js` — token estimation (`estimateTokens`, `partTokens`,
  `countContextTokens`), V2 active-context measurement
  (`measureSessionContext`, including `type: "compaction"` checkpoints), and
  `cacheHitShare`: the observed cache-read share of a turn's prompt, with the
  denominator `input + cache.read + cache.write` verified against recorded
  provider costs.
- `config.js` / `state.js` — the host adapters both plugins share: the
  `OMLX_ROUTER_*` env vars, the config file schema (including the `{env:}`
  placeholder handling), and the `~/.local/state/omlx-router/` state paths
  (pins, decisions, turns). One source of truth for the security-sensitive
  parsing and schema.

Part of the [opencode-router](https://github.com/231self/opencode-router)
monorepo. Apache-2.0.
