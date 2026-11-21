# @231self/opencode-compaction

Context compaction for
[`@231self/opencode-router`](https://www.npmjs.com/package/@231self/opencode-router)
monorepo hosts — OpenCode V2 and Kilo. Plain ESM with a small WASM core; no
npm dependencies beyond `@231self/opencode-shared`.

- **The deterministic context optimiser** (moved from the router plugin):
  prunes and truncates oversized tool outputs to fit the model's real context
  budget, via a pure WASM core (`optimise` ABI) and an in-place plan applied
  to the live message list.
- The plugin **advises and enables** compaction; it never fires compaction
  itself.

Roadmap (see the design spec): cache-aware compaction ROI, a structure-aware
"compact now / not yet" trigger with noise calibration, and the advisory
surfaces.

Install alongside the router:

```sh
opencode plugin add @231self/opencode-compaction
```

Part of the [opencode-router](https://github.com/231self/opencode-router)
monorepo. Apache-2.0.
