# Phase 1 implementation plan — monorepo restructure

Date: 2026-11-21
Spec: `docs/superpowers/specs/2026-11-21-compaction-monorepo-design.md` (§3, §8, §11)
Goal: land the three-package workspace with the crate split; the router becomes
pure model selection. All gates green; all three packages publishable through
the existing staged-release pipeline.

## End state

```
package.json            # private: true, workspaces: ["packages/*"]
scripts/                # check.sh, build-wasm.sh, security-check.mjs orchestrate per package
packages/econ/          # @231self/opencode-econ 0.1.0 — cost.js, tokens.js (+ their tests)
packages/router/        # @231self/opencode-router 0.3.0 — routing plugin + CLI + core crate (`route`)
packages/compaction/    # @231self/opencode-compaction 0.1.0 — optimiser plugin + core crate (`optimise`)
```

Dependency graph: `router → econ`, `compaction → econ`. No router ↔ compaction
dependency. The behaviour change lands here: the router no longer invokes the
optimiser (changelog breaking note in both packages).

## Steps

Each step ends with `bun run check` green; steps are ordered so the suite
moves without ever being red for a reason other than import paths in transit.

1. **Workspace root.** Root `package.json` becomes `private: true` with
   `workspaces: ["packages/*"]`; `bun install` regenerates the lockfile.
   Verify: install clean, `bun run check` green on the untouched layout.
2. **Extract `packages/econ`.** Move `src/cost.js`, `src/tokens.js` and
   `tests/cost.test.js`, `tests/tokens.test.js`; update the router's imports
   to `@231self/opencode-econ` (exports map: `./cost.js`, `./tokens.js`).
   Zero runtime deps. Verify: full suite green.
3. **Crate split — compaction crate.** New `packages/compaction/core/` with
   `lib.rs` (ABI: `alloc`, `dealloc`, `optimise`, `result_len`, `abi_version`),
   `optimise.rs`, and trimmed copies of `envelope.rs` / `types.rs` (self-
   contained; dependency surface stays exactly serde/serde_json as today, no
   new deps). `optimise`'s Rust tests move with it. `build-wasm.sh` builds
   both crates; one 614400 B size gate per artifact.
4. **Trim the router crate.** Remove `optimise` (module and export) from
   `core/`; ABI becomes `alloc`, `dealloc`, `route`, `result_len`,
   `abi_version`. `wasm.js` trap handling for `optimise` moves out. Rust
   tests updated. This is the documented ABI removal.
5. **Split `src/` and the plugin entries.** `packages/compaction/src/` gets
   `optimiser.js`, its own `wasm.js` bridge (optimise-only), and a plugin
   entry registering the optimiser hooks. `packages/router/src/` keeps the
   rest (router, judge, pool, pricing, provision, quality, state, status,
   telemetry, tui, format, config, debug, version) and its entry drops the
   optimiser hooks. `bin/omlx-router.mjs` stays in the router package,
   commands unchanged.
6. **Reorganise tests.** `optimiser.test.js` → compaction; `wasm.test.js`
   splits (route half → router, optimise half → compaction); the rest stay in
   the router. Import paths fixed; suite green.
7. **Per-package manifests.** `files` allowlists (router: `dist/core.wasm`,
   `src/`, `bin/`, `README.md`, `CHANGELOG.md`, `LICENSE`,
   `config.example.json`; compaction: `dist/core.wasm`, `src/`, `README.md`,
   `CHANGELOG.md`, `LICENSE`; econ: `src/`, `README.md`, `CHANGELOG.md`,
   `LICENSE`), `prepack` builds wasm only in the wasm packages, `repository`
   fields point at the monorepo path. Verify each with `npm pack --dry-run`.
8. **Gates and CI.** `check.sh` runs fmt/clippy/test per crate, both wasm
   builds, both size gates, the workspace test suite, and the security gate.
   `security-check.mjs` checks all three packs (allowlists above). **Rule
   change:** "no npm dependencies" becomes "no *external* npm dependencies" —
   `@231self/opencode-econ` as a workspace dependency is allowed; extend
   `tests/security.test.js` to lock this in as a regression test. `ci.yml`
   keeps calling `bun run check`.
9. **Release pipeline.** `release.yml` stages packages in dependency order
   (econ → router → compaction), skipping any package whose version is
   already on npm; per-package `CHANGELOG.md` version guards. Runbook:
   approve econ first (dependents reference it in their manifests), then the
   other two.
10. **Docs.** AGENTS.md (per-package bump lists, build/test commands, the
    releasing section), `docs/releasing.md`, `docs/architecture.md`, root and
    per-package READMEs, changelogs (router 0.3.0: breaking — optimiser moved
    to `@231self/opencode-compaction`, `optimise` ABI removed; econ 0.1.0 and
    compaction 0.1.0: initial).

## Release (end of phase)

1. User creates two trusted-publisher configs on npmjs.com (router exists;
   new: econ and compaction — same repo `231self/opencode-router`, workflow
   `release.yml`, staged-only).
2. Bump: router 0.3.0 (bump list), econ 0.1.0, compaction 0.1.0; changelog
   sections in each package.
3. `bun run check`, push `main`, CI green; tag `v0.3.0`; GitHub Release.
4. `release.yml` stages three versions; user approves **econ first**, then
   router and compaction (2FA each). First-publish 2-day window applies to
   the two new trusted-publisher configs.

## Risks locked into the plan

- The "no npm dependencies" security rule must be narrowed deliberately
  (step 8) — the regression test is the guardrail.
- Two new trusted publishers must see their first publish approved within 2
  days (step 4 of the release).
- The router's behaviour change (no more optimisation) and the ABI removal
  ship together in 0.3.0; changelog and README say so plainly.

## Out of scope (later phases)

`contextDebt` / `compactionRoi` (phase 2), the hybrid trigger, calibration,
surfaces, and the compact-here command (phase 3), context-debt routing
(phase 4), per-pin tolerance bench and the paper (phase 5).
