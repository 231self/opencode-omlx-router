# Implementation plan — opencode-omlx-router v0.1.0

- Date: 2026-11-15
- Design of record: `docs/specs/2026-11-15-opencode-omlx-router-design.md`
- Rule: no TypeScript application code. Rust core, plain-ESM JavaScript adapters.

Each task ends with the listed verification. Commits are conventional, one per
task or small group, described with `jj describe -m`; `main` is pushed only at
milestones.

## M0 — Probe (gating, throwaway)

**Completed 2026-11-15 — see `docs/development.md`.** All five items answered:
V2 switches the in-flight root and subagent turns, plain-object export works,
Kilo switches at the next boundary through the SDK's generic transport, and
`ctx.session.synthetic` starts a model turn (so command output moved to the TUI
part and CLI).

- **T0.1** Probe workspace + plugin: a local OpenCode project with
  `.opencode/plugins/probe/index.js` (plain object export, no
  `@opencode/plugin` import) that logs hook payloads and calls
  `ctx.session.switchModel` on the first prompt.
- **T0.2** Root same-turn test: start on `opencode/iceman-free`, switch to
  `deepseek/deepseek-flash` inside the prompt hook, run one prompt. Inspect the
  assistant message and session model. Record: did the *same* turn use the new
  model?
- **T0.3** Plain-object export test: confirm the plugin loads without importing
  `@opencode/plugin`; if not, record the minimal import needed.
- **T0.4** Subagent test: invoke the `task` tool (or create a child session) and
  confirm the prompt hook fires with `parentID`, and whether a switch in that
  hook affects the child's first turn.
- **T0.5** Kilo test: V1 plugin in a scratch project logging `chat.message`,
  calling `client.session.switchModel` (or the discovered endpoint). Confirm
  ordering and whether the in-flight turn changes.
- **T0.6** Write findings to `docs/development.md`. If T0.2/T0.4 fail, stop and
  re-open the design decision with the user before M1.

Verification: findings recorded, each item answered yes/no with evidence
(assistant model id, log excerpt), probe workspace left behind in `spikes/`.

## M1 — Skeleton

**Completed 2026-11-15:** package metadata, Rust ABI with passthrough stubs,
wasm build and size gate, loader, config seeding/reading, atomic state, status
formatting, adapter skeleton, TUI status shell, CLI, and tests (24 Bun + 8 Rust).

- **T1.1** `package.json` (name, exports, bin, files, scripts, Apache-2.0),
  `rust-toolchain.toml`, `core/Cargo.toml`, directory layout, `.gitignore`
  check.
- **T1.2** Rust ABI: `abi_version`, `alloc`, `dealloc`, `result_len`, `route`,
  `optimise`; serde types; stub decision (pass-through) and optimiser (no-op);
  unit tests for ABI memory and JSON round-trip.
- **T1.3** `bun run build:wasm` (cargo + copy to `dist/core.wasm`), optional
  `wasm-opt`, size gate; `src/wasm.js` loader with ABI check; Bun bridge test.
- **T1.4** Config load/seed/save (`~/.config/omlx-router/config.json`), state
  paths per host, atomic writes, mtime cache; tests for seeding, drift warning,
  invalid JSON.
- **T1.5** V2 adapter registration (prompt/context/compaction hooks registered
  but inert), TUI `/router` status shell, `bin/omlx-router.mjs status`, host
  detection.

Verification: `bun test`, `bun run test:rust`, `bun run build:wasm` pass;
`/router` opens the status dialog in the OpenCode TUI; CLI status prints the
same data.

## M2 — Routing (root sessions)

- **T2.1** Pool: favorites/list/available, catalog filter, glob include/exclude,
  variant resolution, local flag from provider `baseURL`, maxModels; tests with
  fixtures for favorites/available/list.
- **T2.2** Envelope + triage: token estimate, turn class, signals, deterministic
  early exits with reason codes; tests.
- **T2.3** Judge client: `/models` discovery (60 s cache), `auto` size parsing,
  request/parse/repair, timeout/abort, LRU cache, health; tests with a fake HTTP
  server (no real network).
- **T2.4** Scoring: gates, required quality, quality proxy, cost tiers, latency,
  policy weights, shortfall, deterministic tie-break; property/table tests.
- **T2.5** Pin state machine: keep/switch thresholds, flip-flop guard, idle TTL,
  forced pins, compaction reset, escalation counters; tests for each transition.
- **T2.6** Apply: `switchModel`, persisted `lastApplied`, user-override
  detection, decision log write; tests with a fake ctx.
- **T2.7** `route` core wired end to end with the two-phase judge call; adapter
  handler; `need_judge` path tested with fake fetch.

Verification: with real oMLX + a two-model favorites pool, a root session routes
per turn, `/router explain` shows gates/candidates/pin rationale, decisions land
in `decisions.jsonl`, and a user `/model` forces a pin.

## M3 — Context optimiser

- **T3.1** `optimise` core: token estimator, budget, dedupe, truncate, stub,
  protections, overflow; property tests (fits budget, idempotent, protected
  parts untouched, deterministic).
- **T3.2** Context hook wiring: build message/part metadata, apply plan, record
  `beforeTokens` as `lastContextTokens`, log stats; tests applying a plan to a
  fixture message tree.
- **T3.3** Overflow path: pin clear, no further pruning, next-turn re-route;
  compaction hook/event clears pins and skips routing/pruning.

Verification: a synthetic oversized session is pruned to the target budget with
protected parts intact; under-budget turns are byte-identical; overflow logged.

## M4 — Subagents

- **T4.1** Role detection (`parentID`), agent metadata (`agentID`, `agentMode`,
  explicit `agentModel`), forced pin for explicit models.
- **T4.2** Policy resolution order and defaults; quality floors; parent-model
  tie-break; per-session pins.
- **T4.3** Attribution in records and stats; per-session escalation.

Verification: a `task` subagent routes independently (e.g. `explore` picks a
fast/long-context model while the parent stays strong); `/router history`
tags the child; `/router stats` breaks down by agent.

## M5 — Kilo shim

- **T5.1** V1 `server()` export with `chat.message`, `chat.params`,
  `experimental.chat.messages.transform`, `event`; host `kilo`.
- **T5.2** Switch at the confirmed boundary; record `applied: "boundary"`;
  optimiser via messages transform.
- **T5.3** Unsupported detection: if the switch API is missing, log once, mark
  `kilo: unsupported`, do not route.

Verification: a Kilo session either applies routing at the next boundary with a
correctly labelled decision, or reports unsupported without side effects.

## M6 — Surfaces

- **T6.1** TUI `/router` slash command and palette entry: status, on/off,
  policy picker, pool, history, explain, pin/auto, judge, subagents; direct
  config/state access; dialogs and toasts. No server command.
- **T6.2** CLI: status, config get/set, history, doctor, pool.
- **T6.3** Stats aggregation (judge hit rate, switches, pin retention, pruning,
  per-agent).

Verification: every documented command exercised; output matches README.

## M7 — Docs, CI, release

- **T7.1** README kept in sync; `docs/architecture.md`, `docs/protocol.md`,
  `docs/configuration.md`, `docs/development.md`, `docs/troubleshooting.md`.
- **T7.2** GitHub Actions: rustfmt, clippy `-D warnings`, `cargo test`, wasm
  build (binaryen), `bun test`, wasm size gate.
- **T7.3** `npm pack` install test in OpenCode and Kilo (V2 same-turn, Kilo
  boundary); permissions and config seeding verified.
- **T7.4** Tag `v0.1.0`, push `main`, publish to npm (manual step).

Verification: CI green, pack installs in both hosts, README install path works.

## Cross-cutting requirements

- Every new core module has Rust tests; every adapter behaviour has a Bun test
  with fakes; no test touches the network.
- Decision records never contain prompt/message/tool text or keys.
- Each milestone is a jj commit with a conventional message; `bun run check`
  green before pushing.
- README and spec updated in the same commit as behaviour changes.
