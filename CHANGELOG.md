# Changelog

## 0.1.1 — 2026-11-16

### Added

- A **Choose the pool** quickstart with explicit `pool.source: "list"` and
  `pool.models` examples; `/router pool` and `omlx-router pool` now print the
  config path and the exact commands to change the pool.

### Fixed

- An empty `favorites` pool no longer expands to every available model, which
  could silently route to zero-cost models the user never selected. Empty
  favorites now pause routing; `pool.source: "available"` is the explicit
  opt-in, and an unknown source selects nothing.

### Changed

- Clearer plugin IDs: `omlx-router` (server) and `omlx-router.tui` (TUI),
  replacing `omlx.router` / `omlx.router.tui`.
- The TUI part listens for `session.model.selected`, refreshes the session, and
  shows a short model-switch toast, so a routed model is visible even when the
  host footer lags.
- `/router` now opens a navigable action menu with descriptions for every item;
  `/router status` is a compact, aligned view instead of a long text blob.
- `/router pool` is an interactive setup flow for favorites, an explicit model
  list, or the explicit all-available opt-in. When the pool is empty, a startup
  toast and the status hint point to it instead of silently routing.

## 0.1.0 — 2026-11-16

First release.

### Added

- Per-turn routing for OpenCode V2, with same-turn model switching from the
  prompt hook.
- Deterministic Rust/WASM decision core: turn envelope, triage, scoring,
  cache-aware pinning, optimiser planning.
- oMLX small-model judge with automatic smallest-model selection, 5 s default
  timeout, LRU verdict cache, repair retry, and deterministic fallback.
- Judge provisioning with explicit consent: TUI/CLI offer, model metadata and
  size before confirmation, oMLX admin download, progress, cancel, and
  post-download verification. Never downloads automatically.
- Live prompt tests (`tests/e2e`) for OpenCode V2 and Kilo: deterministic judge
  stub, multi-turn pin/threshold/jump/override scenarios, subagent policy,
  judge failure and malformed-output fallbacks, disabled mode, Kilo boundary
  semantics, and a real-oMLX judge smoke test. Each step asserts the decision
  record, the model the host actually used, and per-turn timing.
- Per-turn telemetry from host events: routing, local judge, remote model,
  tool/other, time to first token, steps, tokens, and cost. `/router timing`,
  `omlx-router timing`, and `/router status` show the split; records are
  `turns.jsonl` with no prompt text.
- `tests/judge-calibration.mjs` measures the real judge's verdicts and latency
  on simple/edit/debug/planning/review/large-context cases.
- Pool sources: host favorites (default), explicit list, all available models;
  include/exclude globs; tool, context, and status filters; local-model guard.
- Policies: cost-first (default), quality-first, latency-first, with per-agent
  overrides for all of them.
- Cache-aware pinning with switch threshold, idle TTL, flip-flop guard, user
  `/model` override detection, compaction reset, and per-session tool-failure
  escalation.
- Context optimiser: dedupe, truncate, stub stale tool outputs, protect system
  and user text, overflow hand-off to host compaction.
- Subagent routing: role detection, agent policies, explicit agent-model forced
  pins, parent-model tie-break, independent pins and escalation.
- OpenCode TUI `/router` command and palette entry: status, on/off, interactive
  policy picker, pool, history, timing, explain, pin/auto, judge probe,
  subagents.
- Kilo V1 shim: routes at the next request boundary through the SDK transport,
  best-effort optimiser transform, boundary-labelled decisions.
- `omlx-router` CLI: status, config get/set, history, timing, doctor, pool.
- Apache-2.0 license, CI (rustfmt, clippy, Rust tests, wasm build, Bun tests,
  wasm size gate), and user documentation.

### Fixed

- The 4B judge copied the schema's `complexity: 1` example and under-classified
  debug, review, and planning turns. The judge prompt now uses few-shot examples
  and an explicit "do not copy" rule; the core also raises the judge verdict to
  a deterministic floor from code, error, planning, review, and context signals.
- Marker matching now uses word boundaries and common inflections, so `Inspect`
  no longer matches `spec`, `prefix` no longer matches `fix`, and `designs` /
  `tests` still match their markers.
- Multi-file turns now set a `multiFile` signal; planning and review turns have
  a minimum complexity of 3. The routing eval found two under-routes (a
  three-file refactor and a design comparison) before this change; both now
  match the oracle.
- The default judge timeout is 5 s: the 4B is usually under 1 s but cold calls
  measured 3.4 s.

- The OpenCode V2 context hook only reports a model's provider and id. The
  adapter now fills in limits from the live catalog, so the optimiser no longer
  sees zero context and reports a false overflow on every turn.
- Context-hook state writes no longer overwrite a routing pin written by a
  concurrent prompt hook. Cache-aware pinning now survives turns with tool use.
- Pin policy: a downward complexity change no longer counts as a jump, a
  selection that stays on the incumbent is no longer recorded as a switch, and
  idle TTL only switches when a different model is actually best.
- A rejected `switchModel` call is recorded with `applied: "none"` and the
  error, instead of claiming the decision was applied.

### Notes

- No TypeScript application code; no Python runtime.
- Kilo cannot switch the in-flight turn through its V1 API; decisions apply at
  the next boundary.
