# Architecture

The monorepo has three layers across three packages:

```text
host (OpenCode V2 / Kilo, Bun)
└── plain-JS adapters (packages/*/src/)
    ├── packages/router/dist/core.wasm       Rust routing engine (pure, no I/O)
    ├── packages/compaction/dist/core.wasm   Rust context-optimiser engine (pure, no I/O)
    ├── oMLX HTTP judge                      adapter-side fetch with timeout + cache
    └── files                                config, pins, decision log (packages/shared)
```

## Packages and adapters

| File | Role |
|---|---|
| `packages/router/src/index.js` | V2 `setup` + V1 `server`; loads the core, registers routing hooks |
| `packages/router/src/router.js` | Turn orchestration: host state → core → judge → switchModel/pin/log |
| `packages/router/src/pool.js` | Favorites/list/available resolution and filters |
| `packages/router/src/pricing.js` / `quality.js` | Public price and quality tables: fetch, cache, lookup |
| `packages/router/src/judge.js` | oMLX model discovery, verdict call, LRU cache, probe |
| `packages/router/src/telemetry.js` | Host event subscription → per-turn timing, tokens, cost |
| `packages/router/src/tui.js` | OpenCode TUI `/router` command (no server commands) |
| `packages/router/bin/omlx-router.mjs` | CLI (`opencode-model-router`) for headless/Kilo/Desktop |
| `packages/compaction/src/index.js` | V2 `context` hook + Kilo transform; the optimiser surface |
| `packages/compaction/src/context.js` | Optimise + pin measurement, catalog limit fill-in |
| `packages/compaction/src/optimiser.js` | Builds optimise requests and applies pruning plans |
| `packages/shared/src/cost.js` / `tokens.js` | Cost shape normalisation, modelled cost, token measurement |
| `packages/shared/src/config.js` / `state.js` | Config seeding, atomic state files |
| `packages/shared/src/kilo.js` / `refs.js` | Kilo ctx shim; model-ref semantics |

The adapters perform only plumbing: host API calls, HTTP, file I/O, and applying
the core's decisions. All routing and pruning policy lives in Rust.

## Cores

Each `core/` compiles to `wasm32-unknown-unknown` and exposes a small C ABI
(`docs/protocol.md`): `alloc`/`dealloc`/`result_len`/`abi_version` plus `route`
(router) or `optimise` (compaction). They have no imports, no clock, and no
randomness: the adapter passes `nowMs`, pool data, pins, settings, and any judge
verdict in; the core returns a decision, next pin, decision record, and
counters, or a judge request. This makes them deterministic and testable with
`cargo test`.

Modules:

| Module | Responsibility |
|---|---|
| `envelope` | Token estimate, turn class, signals |
| `triage` | Heuristic verdict, escalation, sanitising |
| `score` | Hard gates, required quality, cost/latency/quality scoring |
| `pin` | Cache-aware selection, switch threshold, flip-flop guard, idle TTL |
| `judge` | Verdict prompt + cache key |
| `optimise` | Deterministic dedupe/truncate/stub planner |
| `route` | Pipeline and response shapes |

## One turn

1. Host hook receives the user turn (V2 `prompt`; Kilo `chat.message`).
2. Adapter detects root vs subagent (`parentID`), agent, explicit agent model,
   current session model, a user override (session model != last applied), and
   the failure streak.
3. Pool resolution filters the live catalog (chat, enabled, tools, context,
   globs) and annotates cost, limits, local flag, variant.
4. Core builds the envelope and either short-circuits (trivial, escalation,
   forced pin) or asks for a judge verdict.
5. Adapter calls oMLX, caches the verdict, calls the core again.
6. Core gates/scorers/pins and returns the chosen model.
7. Adapter calls `switchModel`, writes the pin, decision record, and stats.
8. Same turn, the `context` hook calls the optimiser and applies the plan; the
   resulting token total feeds the next routing decision. The V2 context event
   carries only `providerID`/`id`, so the adapter resolves limits from the live
   catalog before measuring. Context writes merge with the latest pin and never
   overwrite a model chosen by a concurrent prompt hook.
9. `telemetry` subscribes to `session.execution.*` and `session.step.*` events.
   At execution end it records the routing/judge time from the prompt hook and
   the remote model, tool, and total turn time in `turns.jsonl`.

## Subagents

Child sessions have `parentID`; the adapter passes role, agent id, and agent
model. Core policy order: explicit agent model (forced, unless overridden) →
per-agent policy → subagent default → global policy. Child pins are independent.
On an exact score tie the parent's model wins to reuse prompt cache. Escalation
is per session.

## Cache-aware pinning

`pin.mode` selects the trade-off: `cache` keeps the incumbent to reuse its
provider cache, `balanced` (default) applies a switch threshold plus age/turn/
cost releases, and `switch` takes the best candidate every turn with cold-cache
scoring. Provider prompt caches are not portable across models; a switch pays
one full prefill and the new model may cache its own prefix afterwards.

Naive per-turn switching destroys provider prompt caches. The pin keeps the
incumbent when it clears gates and the challenger does not beat it by
`pin.switchThreshold`. Pins break on gate failure, a complexity jump of two or
more, repeated tool failures, context overflow, policy change, or idle TTL. A
flip-flop guard blocks models used in the last few turns. A user `/model`
override becomes a forced pin.

## Optimiser

Runs only in the `context` hook, never for compaction/title/generate. Under
budget it changes nothing. Over budget it deduplicates identical tool outputs,
truncates oversized outputs, then stubs old outputs, preserving system text,
user text, the first user message, recent turns, and error prefixes. If it
cannot fit, it returns `overflow`, the adapter clears the pin, and the host
compaction path takes over.

## Failure isolation

- Missing/invalid wasm, ABI mismatch, or trap: routing disabled, host unchanged.
- Telemetry event errors, missing events, or disk failures: ignored; routing and
  the turn continue.
- Judge timeout/HTTP/parse error: heuristic verdict; log records `used: false`.
- `switchModel` rejection: logged, pin kept, next turn retries.
- Config/state write failures: continue in memory; status reports the warning.
- Optimiser apply failure: request sent unmodified.

## State

```text
~/.config/omlx-router/config.json          shared settings
~/.local/state/omlx-router/opencode/pins/<sha>.json
~/.local/state/omlx-router/opencode/decisions.jsonl      (5 MB rotation)
~/.local/state/omlx-router/opencode/turns.jsonl          (5 MB rotation)
~/.local/state/omlx-router/opencode/stats.json
~/.local/state/omlx-router/kilo/…          same layout per host
```

Writes are atomic. Decision records never contain prompt or tool text.
