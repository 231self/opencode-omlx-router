# Changelog

## 0.1.0 — 2026-11-15

First release candidate.

### Added

- Per-turn routing for OpenCode V2, with same-turn model switching from the
  prompt hook.
- Deterministic Rust/WASM decision core: turn envelope, triage, scoring,
  cache-aware pinning, optimiser planning.
- oMLX small-model judge with automatic smallest-model selection, 1.5 s default
  timeout, LRU verdict cache, repair retry, and deterministic fallback.
- Judge provisioning with explicit consent: TUI/CLI offer, model metadata and
  size before confirmation, oMLX admin download, progress, cancel, and
  post-download verification. Never downloads automatically.
- Live prompt tests (`tests/e2e`) for OpenCode V2 and Kilo: deterministic judge
  stub, multi-turn pin/threshold/jump/override scenarios, subagent policy,
  judge failure and malformed-output fallbacks, disabled mode, Kilo boundary
  semantics, and a real-oMLX judge smoke test. Each step asserts the decision
  record and the model the host actually used.
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
  policy picker, pool, history, explain, pin/auto, judge probe, subagents.
- Kilo V1 shim: routes at the next request boundary through the SDK transport,
  best-effort optimiser transform, boundary-labelled decisions.
- `omlx-router` CLI: status, config get/set, history, doctor, pool.
- Apache-2.0 license, CI (rustfmt, clippy, Rust tests, wasm build, Bun tests,
  wasm size gate), and user documentation.

### Fixed

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
