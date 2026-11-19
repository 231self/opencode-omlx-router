# opencode-omlx-router — Design

- Status: approved design, pre-implementation
- Date: 2026-11-15
- Repository: https://github.com/231self/opencode-router
- License: Apache-2.0

## 1. Problem and goals

Coding agents make you pick one model for a whole session. That is wrong in both
directions: a "what does this function do" question burns frontier-model tokens,
and a gnarly refactor run on a small model fails and costs more in retries.

This project is an installable OpenCode V2 / Kilo plugin that selects the best
model from a user-defined pool **per turn**, using a small local model served by
oMLX as the routing brain, and keeps the context inside the selected model's
budget. It ports the transferable ideas from
[`pi-smart-router`](https://github.com/beettlle/pi-smart-router) — turn envelope,
deterministic triage, context-fit gate, cache-aware pinning, loop escalation,
decision logging — without its HyDRA/ONNX embeddings, calibration pipeline,
virtual-cost accounting, planning delegate, or adaptive-reasoning machinery.

### Goals

1. Route each user turn (root session and subagent sessions) to the best model
   from a configured pool.
2. Use a small oMLX-served model as the judge, with deterministic fallbacks when
   it is slow, down, or unreliable.
3. Preserve prompt-cache economics with per-session pinning and a switch
   threshold, instead of naive turn-by-turn thrash.
4. Keep context within the routed model's window with deterministic, cache-safe
   pruning; never call another model to do it.
5. Give the user full visibility and control: policy, pool, pins, decisions,
   judge health.
6. Be installable in both hosts from one npm package, with a documented
   best-effort Kilo mode.
7. Contain no TypeScript application code: plain JavaScript host adapters and a
   Rust core compiled to WebAssembly.

### Non-goals (v1)

- HyDRA / ONNX embedding matching, benchmark calibration, `p(success)` models.
- Virtual cost v2, subscription economics, quota windows.
- Planning delegate, adaptive reasoning-level control, sub-routing.
- A local protocol-translating dispatch proxy or a synthetic `auto` provider.
- OpenCode Desktop GUI plugin part.
- Automatic model download; the user pulls the judge model in oMLX.
- Multi-user or remote-host operation (oMLX is expected on localhost).
- Cost budgets or hard spend caps.

## 2. Verified environment (2026-11-15)

| Component | Version / fact |
|---|---|
| OpenCode | `2.3.0` at `~/.opencode/bin/opencode`; V2 plugin API `@opencode/plugin` |
| Kilo CLI | `7.6.2` (`@kilocode/cli`), V1-style plugin hooks (`chat.message`, `chat.params`) |
| oMLX | `0.6.4` app; OpenAI-compatible server at `127.0.0.1:1234`; no router endpoint; SpecPrefill request knobs exist but are unused in v1 |
| oMLX models | Only `Qwen3.8-27B-MLX-4bit` currently loaded; a small judge model must be pulled |
| Rust | `1.98.1`, targets `aarch64-apple-darwin`, `wasm32-unknown-unknown`, `wasm32-wasip1` |
| Bun | `1.4.4` |
| jj | `0.47.1`, colocated with git `2.56.1` |
| GitHub | `gh` authenticated as `amit231self`; org `231self` |

Favorites are persisted per host:

- OpenCode: `~/.local/state/opencode/model.json` → `favorite: [{providerID, modelID}]`, plus `variant: {"provider/model": "level"}`.
- Kilo: `~/.local/state/kilo/model.json` → same shape.

OpenCode V2 facts this design relies on:

- `ctx.session.hook("prompt", ...)` runs once per admitted user turn, before model resolution, and may run async work.
- `ctx.session.switchModel({sessionID, model})` changes the model used by subsequent requests.
- `ctx.session.hook("context" | "compaction", ...)` expose mutable `system`, `messages`, `tools`, `options` immediately before dispatch.
- `experimental.model.resolve` can change the model per request **only within the same provider**; therefore it cannot serve a cross-provider pool. It is not used in v1.
- `ctx.session.synthetic({sessionID, text})` is the intended way for a command to show output.
- `Agent.Info.model`, `Session.Info.model`, and `Session.Info.parentID` exist.
- `ctx.provider.list()` exposes provider settings, including a `baseURL` used to flag local providers.

## 3. Architecture

```
host server (Bun, OpenCode V2 / Kilo)
└── src/index.js                    one default export: { id, setup } (V2) + server() (V1)
    ├── dist/core.wasm              Rust core, pure deterministic decision engine
    ├── host adapter                model catalog, hooks, switchModel, commands, fetch
    ├── oMLX judge                  HTTP from the adapter, AbortController timeout
    └── ~/.config/omlx-router/config.json
        ~/.local/state/omlx-router/<host>/…
```

### Units

| Path | Responsibility |
|---|---|
| `src/index.js` | V2 `setup`/hooks/commands + V1 `server()`; host detection; lifecycle |
| `src/wasm.js` | Load and instantiate `core.wasm`; alloc/call/read/dealloc helpers; ABI check |
| `src/host/v2.js` | V2 wiring: prompt/context/compaction hooks, commands, events, model catalog |
| `src/host/v1.js` | Kilo wiring: `chat.message`, `chat.params`, `experimental.chat.messages.transform` |
| `src/pool.js` | Favorites/list/available resolution, filters, variant resolution, local flag |
| `src/judge.js` | oMLX model discovery, request, JSON parsing, timeout, cache, health |
| `src/apply.js` | `switchModel` application, optimiser plan application, user-override detection |
| `src/state.js` | Config read (mtime), pin files, decision log append, stats, atomic writes |
| `src/commands.js` | Shared status/decision formatting used by the TUI part and the CLI (no server-side command registration) |
| `src/tui.js` | OpenCode TUI part: `/router` slash command + palette entry, dialogs/toasts, direct config/state access |
| `bin/omlx-router.mjs` | CLI: status/config/history/doctor/pool |
| `core/src/lib.rs` | ABI: `abi_version`, `alloc`, `dealloc`, `result_len`, `route`, `optimise` |
| `core/src/{envelope,triage,pool,score,pin,optimise,types}.rs` | Pure logic + serde types |
| `tests/` | Bun adapter tests, WASM bridge tests, fixtures |
| `core/tests/` | Rust unit + property tests |

The core is **pure**: no I/O, no clock, no randomness, no imports. The adapter
supplies `nowMs`, pool data, pins, settings, and the judge verdict, and persists
whatever state the core returns. This keeps routing deterministic and testable
with `cargo test`, and keeps the WASM ABI free of wasm-bindgen glue.

### WASM ABI

Exports:

```text
abi_version() -> u32
alloc(len: u32) -> ptr
dealloc(ptr: u32, len: u32)
result_len() -> u32
route(ptr: u32, len: u32) -> ptr        // JSON in, JSON out
optimise(ptr: u32, len: u32) -> ptr     // JSON in, JSON out
```

`route` input (abridged):

```json
{
  "abi": 1,
  "nowMs": 1763210000000,
  "host": "opencode",
  "kind": "primary",
  "role": "root",
  "session": {
    "hash": "9f2c…",
    "parentHash": null,
    "agentID": "build",
    "agentMode": "primary",
    "agentModel": null,
    "currentModel": {"providerID": "deepseek", "id": "deepseek-flash", "variant": "high"}
  },
  "turn": {
    "promptText": "…",
    "promptTokens": 240,
    "images": 0,
    "lastContextTokens": 18400,
    "toolFailures": 0,
    "turnClassHint": null
  },
  "pool": [
    {
      "providerID": "deepseek",
      "modelID": "deepseek-flash",
      "name": "DeepSeek Flash",
      "variant": "high",
      "local": false,
      "cost": [{"input": 0.2, "output": 0.8, "cache": {"read": 0.05, "write": 0.2}}],
      "limit": {"context": 262144, "output": 131072},
      "capabilities": {"tools": true, "input": ["text"], "output": ["text"]},
      "reasoning": true,
      "status": "active",
      "qualityOverride": null,
      "latencyOverrideMs": null
    }
  ],
  "settings": {"…": "normalized config subset"},
  "pin": {"…": "previous pin or null"},
  "judge": {"verdict": {"…": "…"}} ,
  "stats": {"decisions": 12, "switches": 3}
}
```

`route` output:

```json
{
  "action": "decide",
  "decision": {
    "providerID": "deepseek",
    "id": "deepseek-flash",
    "variant": "high",
    "source": "judge",
    "reason": "complexity=2;cost-first;cache-kept",
    "pinned": true,
    "latencyMs": 41,
    "candidates": [
      {"providerID": "deepseek", "id": "deepseek-flash", "score": 0.82, "costUsd": 0.0041},
      {"providerID": "openai", "id": "gpt-6.1-terra", "score": 0.71, "costUsd": 0.0920}
    ]
  },
  "pin": {"…": "next pin state"},
  "log": {"…": "decision record"},
  "state": {"…": "counters"}
}
```

When a verdict is required, the same call returns:

```json
{
  "action": "need_judge",
  "judgeRequest": {"model": "Qwen3-4B-Instruct-2507-4bit", "prompt": "…", "cacheKey": "sha256:…"},
  "pin": {"…": "unchanged"},
  "state": {"…": "unchanged"}
}
```

The adapter performs the HTTP call and calls `route` again with
`judge.verdict` populated. Cached verdicts skip the HTTP hop.

`optimise` input/output:

```json
{
  "abi": 1,
  "model": {"limit": {"context": 128000, "output": 8192}},
  "settings": {"reserveOutputTokens": 8192, "maxToolTokens": 2000, "keepRecentToolOutputs": 3, "keepRecentTurns": 2, "safetyTokens": 1024},
  "messages": [
    {"index": 0, "role": "assistant", "parts": [
      {"index": 0, "type": "tool", "tool": "read", "tokens": 8200, "text": "…"},
      {"index": 1, "type": "text", "tokens": 40, "text": "…"}
    ]}
  ]
}
```

```json
{
  "plan": [
    {"message": 0, "part": 0, "action": "truncate", "headChars": 6000, "tailChars": 4000, "marker": "…"},
    {"message": 0, "part": 0, "action": "stub", "placeholder": "[omlx-router: pruned read output, ~8200 tokens omitted to fit …]"}
  ],
  "stats": {"beforeTokens": 131000, "afterTokens": 118400, "partsPruned": 2, "overflow": false}
}
```

Plans are computed in order and the adapter applies them in order; `optimise` is
deterministic and idempotent for a given input. ABI mismatches, traps, malformed
JSON, or plan-application errors cause a logged pass-through, never a failed turn.

## 4. Per-turn flow (root, OpenCode V2)

1. `prompt` hook fires with `sessionID` and the prompt draft.
2. Adapter loads config (mtime-cached), the session pin file, and a cached pool
   snapshot (rebuilt on `model.updated` / `config.updated` / 5 min TTL).
3. Adapter resolves role: `ctx.session.get` → `parentID` present means subagent;
   agent identity and explicit `agentModel` come from `ctx.agent.get`.
4. Adapter builds the `route` request: prompt text, prompt token estimate, last
   observed context tokens, tool failure streak, current model, pool, settings,
   pin, counters, cached judge verdict (if any).
5. Core runs: hard gates → turn envelope → deterministic triage → judge request
   or cached verdict → scoring → pin policy → decision. The envelope emits a
   `turnClass` of `trivial`, `routine`, `tool_continuation`, `agentic`,
   `planning`, or `review`, used by triage and by the pin's "turn class changed"
   rule.
6. If `need_judge`: adapter calls oMLX (timeout 5000 ms), caches the parsed
   verdict, and calls `route` again.
7. Adapter applies the decision with `ctx.session.switchModel` (providerID, id,
   variant), writes the pin, appends the decision record, and stores
   `lastApplied`.
8. `context` hook (same turn) receives the assembled `system`/`messages`/`tools`
   for the resolved model. Adapter calls `optimise`, applies the plan, records
   `stats.beforeTokens` as the next turn's `lastContextTokens`.
9. `compaction` hook/event: pins are cleared; the compaction request is not
   routed or pruned; the next turn re-routes.
10. `tool.execute.after` failures update the session's failure streak; three
    identical consecutive failures trigger escalation.
11. On every prompt, adapter compares `session.model` with `lastApplied`; a
    mismatch is a user `/model` override and becomes a forced pin. `lastApplied`
    is persisted in the pin file, not only in memory, so adapter or host
    restarts do not misread the session's model as a user override.

## 5. Subagent routing

- The `prompt` hook runs for child sessions too. Adapter detects `parentID`,
  passes `role: "subagent"`, `agentID`, `agentMode`, and the task prompt.
- Child sessions have independent pins. They never inherit the parent's pin.
  On an exact score tie, the parent's current model wins (cache reuse).
- Policy resolution order:
  1. Explicit `agent.model` in config → forced pin, unless
     `subagents.overrideExplicitModel: true`.
  2. `subagents.agents[agentID]` policy/floor.
  3. `subagents.default`.
  4. Active global policy.
- Deterministic agent mapping seeds the judge verdict when the agent is known:
  `explore`/`search` → cost or latency, tools required, context floor ≥128k;
  `general`/`build` → active policy, quality floor 0.55; `review`/`plan` →
  quality, floor 0.75/0.80.
- Loop escalation is per session; children escalate without affecting the parent.
- Decision records carry `role`, `agentID`, and `parentHash`; `/router history`
  tags subagent rows; `/router stats` aggregates by agent.

## 6. Pool

| `pool.source` | Behaviour |
|---|---|
| `favorites` (default) | Host `model.json` `favorite[]`, filtered against the live catalog; empty ⇒ `available` with a status warning |
| `list` | `pool.models` entries `provider/model` or `provider/model#variant` |
| `available` | All enabled chat models from the host catalog |

Always applied: chat type, enabled, not deprecated, dedupe by
`providerID/modelID`, resolve variant (explicit > host variant map > `default`),
attach provider base URL and `local` flag (loopback host), cap the judge
candidate table at `pool.maxModels` (8), keep the full pool for gates/scoring.
Defaults: `requireTools: true`, `minContext: 32000`. `pool.include` and
`pool.exclude` accept glob patterns and are applied last.

Each pool model carries a normalised cost plus a `costSource`. The host emits
several shapes — catalog tier arrays, models.dev's flat
`{input, output, cache_read, cache_write}` with `tiers` and
`context_over_200k`, and the V2 client's `{text: {input: {price}}}` with context
overrides — and OpenCode reports `cost: []` for some providers and all-zero
prices for others. A price the host omits stays missing rather than becoming 0,
so a display can say `unknown`; gaps are then filled from the public models.dev
then LiteLLM tables (`pricing.sources`, no access token, cached 24 h at
`pricing.json`). Only missing or zero fields are replaced, so first-party
billing still wins when the host reports it. `costSource` is `catalog`,
`modelsdev`, or `unknown`, and `pool.localCostZero` keeps loopback models free.

## 7. Judge

- Discovery: `GET {baseURL}/models`, cached 60 s. `judge.model` wins; `auto`
  picks the smallest id by parsed parameter size (`0.5B`–`8B`), never a large
  model when a small one exists. If no id exposes a parameter size, `auto` uses
  the first advertised model and `/router judge` shows which one was chosen.
- Auth: `apiKey` from config, `{env:VAR}` expansion supported; oMLX may not
  require one.
- Request: `POST {baseURL}/chat/completions`, temperature 0, `max_tokens` 200,
  `response_format: {type: "json_object"}` attempted; lenient parse (strip
  fences, first balanced object); one repair retry; then heuristic fallback.
- Prompt: ≤1200 tokens: turn summary (truncated), envelope signals, candidate
  table (`id`, context, tools, cost in/out, quality class, local).
- Verdict:

  ```json
  {"task": "trivial|edit|debug|refactor|plan|research|review|ui",
   "complexity": 1,
   "needsTools": true,
   "needsVision": false,
   "contextNeed": "small|medium|large",
   "reasoningNeed": "low|medium|high",
   "confidence": 0.8}
  ```

- Cache: LRU 128, key `sha256(kind, agentID, prompt fingerprint, candidate ids,
  policy)`, TTL 10 min. `confidence < 0.35` is treated as unknown and blended
  with triage.
- Failure: `judge.enabled: false`, timeout, HTTP error, or unparsable output ⇒
  heuristic verdict from turn signals. Routing continues; status records it.

## 8. Scoring

Hard gates: available and not deprecated, tools when required, vision when
images are present, context fit (`estimate ≤ 0.90 × limit.context`).

Required quality from complexity: 1→0.25, 2→0.40, 3→0.55, 4→0.75, 5→0.90;
`+0.10` when `reasoningNeed == high`; `+0.05` for planning/review turns;
subagent floors apply as a minimum.

Quality proxy (overridable per model):

```text
0.45 · pricePercentile
+ 0.25 · sizeHeuristic      (>=30B 0.95, 8–30B 0.75, 3–8B 0.55, <3B 0.35)
+ 0.15 · contextPercentile
+ 0.15 · reasoningSupport    (variants / supportsEffortUpdates / requireReasoning)
```

Zero-cost local models default to quality 0.35. `quality.overrides` wins.
When every candidate has the same price or the same context size, that
percentile is neutral (0.5) rather than undefined.

Shortfall `= max(0, required − quality)`; penalty `= shortfall × 2.5`; exclude
when shortfall > `limits.shortfallTolerance` (0.20).

Cost: applicable cost tier for expected input (`lastContextTokens +
promptTokens`) × input price + `expectedOutputTokens` (default 1200; 8% of
context on agentic turns) × output price. When pinned and the provider supports
prompt cache keys, charge `pin.cacheHitRatio` (0.8) of context at the cache-read
price.

Latency score: local 1.0; otherwise `latency.overrides` or `1 −
pricePercentile` (cheap ≈ fast).

Final score:

```text
w_cost · costScore + w_quality · quality + w_latency · latencyScore − penalty
```

Policy weights: `cost` 0.6/0.3/0.1 (default), `quality` 0.1/0.8/0.1, `latency`
0.2/0.2/0.6. Local models are ineligible above complexity 2 unless
`limits.allowLocalForComplexity` raises it or an override sets sufficient
quality. Deterministic tie-break: score desc, cost asc, context desc, id asc.
Top three candidates are recorded.

## 9. Pinning

Pin state per session:

```json
{"model": {"providerID": "…", "id": "…", "variant": "…"},
 "since": 1763210000000, "lastTurnAt": 1763210100000,
 "lastTurnClass": "tool_continuation", "switchCount": 4,
 "away": [{"providerID": "…", "id": "…", "at": 1763210000000}],
 "source": "route", "forced": false}
```

- Keep when the pin clears gates, `best − pinned ≤ pin.switchThreshold` (0.12),
  the turn class is unchanged, idle < `pin.idleTtlMs` (5 min), and not forced.
- Hard switch on gate failure, an **upward** complexity jump ≥ 2, loop
  escalation, context overflow, policy change, or pin expiry. A downward jump is
  a normal de-escalation governed by the threshold.
- If the incumbent is still the best candidate, the pin is refreshed and the
  decision is recorded as pinned, not as a switch (this also applies to idle TTL
  and same-model selections).
- Flip-flop guard: never switch to a model used in the last `pin.flipFlopTurns`
  (3) turns.
- User override: `session.model != lastApplied` at prompt time ⇒ forced pin,
  `source: "user"`. Released only by `/router auto`, compaction, or model
  removal.
- Compaction clears pins. Escalation pins the highest-quality adequate model
  until three successful turns, then resumes policy routing.
- Forced pins ignore idle TTL and thresholds.

### Context-safe downgrades

The OpenCode V2 prompt hook reads the active context for decisions involving
smaller input budgets. It checks the new prompt and reserves space for output
and instruction overhead. A separate scoring pass can identify a preferred
smaller model that does not fit; this pass can only queue compaction, never
apply a decision. The per-session guard survives pin release and compaction
initiation. On a later prompt, a new completed checkpoint and a fresh fit check
are required for a downgrade. Missing measurements and failed or insufficient
compactions leave the downgrade deferred without an automatic retry loop.

## 10. Context optimiser

- Budget `= limit.context − reserve`, `reserve = min(reserveOutputTokens, output
  limit) + safetyTokens` (8192 and 1024 by default).
- Token estimate: text `ceil(chars/4)` ASCII-weighted, CJK `chars/1.6`, images
  1500 each, tool output like text.
- Under budget ⇒ **no change** (idempotent, cache-safe).
- OpenCode V2's `context` event carries only `providerID`/`id`; the adapter
  resolves the catalog entry to obtain limits before measuring. Context writes
  read the latest pin at write time and never overwrite a model chosen by a
  concurrent prompt hook.
- Over budget, in order: dedupe identical tool outputs (keep newest) → truncate
  outputs above `maxToolTokens` (2000) to 60% head / 40% tail with marker →
  stub outputs older than the last `keepRecentToolOutputs` (3), largest first,
  until fit.
- Protected: system parts, user text, first user message, last
  `keepRecentTurns` (2) messages. Error tool results are stubbed with their
  first 200 chars preserved.
- Still over ⇒ `overflow: true`, no further pruning, pin cleared, host
  compaction handles it; the next turn routes to a larger-context model.
- Only the `context` hook is optimised. `compaction`, `title`, and `generate`
  requests are never pruned or routed.
- Markers: `[...truncated N tokens...]` and
  `[omlx-router: pruned <tool> output, ~N tokens omitted to fit <model> context]`.

## 11. Configuration and state

Config path: `~/.config/omlx-router/config.json`. It is the single source of
truth for runtime settings. Plugin options in `opencode.jsonc` / Kilo config are
read **once** to seed the file when it does not exist; afterwards the file wins
and `/router status` warns if options drift. This lets the TUI picker and manual
edits work predictably.

```json
{
  "enabled": true,
  "policy": "cost",
  "pool": {
    "source": "favorites",
    "models": [],
    "include": [],
    "exclude": [],
    "maxModels": 8,
    "requireTools": true,
    "minContext": 32000
  },
  "judge": {
    "enabled": true,
    "baseURL": "http://127.0.0.1:1234/v1",
    "model": "auto",
    "apiKey": "{env:OMLX_API_KEY}",
    "timeoutMs": 5000,
    "cacheTtlMs": 600000,
    "cacheSize": 128
  },
  "pin": {
    "switchThreshold": 0.12,
    "idleTtlMs": 300000,
    "flipFlopTurns": 3,
    "cacheHitRatio": 0.8
  },
  "optimiser": {
    "enabled": true,
    "reserveOutputTokens": 8192,
    "safetyTokens": 1024,
    "maxToolTokens": 2000,
    "keepRecentToolOutputs": 3,
    "keepRecentTurns": 2
  },
  "limits": {
    "shortfallTolerance": 0.2,
    "allowLocalForComplexity": 2,
    "expectedOutputTokens": 1200,
    "contextFitRatio": 0.9
  },
  "quality": {"overrides": {}},
  "latency": {"overrides": {}, "localProviders": []},
  "pricing": {"source": "modelsdev", "sources": ["modelsdev", "litellm"], "refreshHours": 24},
  "subagents": {
    "enabled": true,
    "overrideExplicitModel": false,
    "default": {"policy": "cost", "qualityFloor": 0.0},
    "agents": {
      "explore": {"policy": "latency", "qualityFloor": 0.45, "minContext": 128000},
      "general": {"policy": "cost", "qualityFloor": 0.55},
      "review": {"policy": "quality", "qualityFloor": 0.75},
      "plan": {"policy": "quality", "qualityFloor": 0.8}
    }
  },
  "debug": false
}
```

State paths, per host (`opencode` | `kilo`):

```text
~/.local/state/omlx-router/<host>/pins/<session-hash>.json
~/.local/state/omlx-router/<host>/decisions.jsonl
~/.local/state/omlx-router/<host>/decisions.jsonl.1
~/.local/state/omlx-router/<host>/stats.json
```

Writes are atomic (temp file + rename). Concurrent instances never share a pin
file. The decision log rotates at 5 MB with one backup.

## 12. Commands, TUI, CLI

The command surface lives in the **OpenCode TUI part**, not in a server command.
Probing showed that `ctx.session.synthetic` displays output but also starts a
model turn, which would make every status check cost money. A server command has
no other display channel.

The TUI part (plain JavaScript, no JSX/TypeScript) registers a `/router` slash
command and a palette entry **"oMLX Router: settings"**:

| Input | Behaviour |
|---|---|
| `/router` | Action menu: every command below, with descriptions, plus the routing and subagent toggles |
| `/router status` | Compact status: state, judge, pins, timing, last decision |
| `/router on` / `/router off` | Toggle, persisted to config; routing is on by default |
| `/router policy [cost\|quality\|latency\|custom]` | Interactive picker or direct set; writes config, clears pins |
| `/router pin-mode [cache\|balanced\|switch]` | Interactive picker or direct set; writes config, clears pins |
| `/router pool` | List resolved models with inferred quality/cost/local flags and exclusion reasons |
| `/router pricing [refresh]` | Per-pool-model token prices with their source; `refresh` refetches the public tables |
| `/router pins [clear]` | Per-session routing state with active blocks; `clear` releases them all |
| `/router quality [refresh]` | Score source, per-source counts, and cache age |
| `/router history [n]` | Recent decisions from `decisions.jsonl`, optionally filtered to the current session |
| `/router timing [n]` | Judge vs remote model vs tool time per turn |
| `/router explain` | Full trace of the current session's last decision |
| `/router pin [provider/model]` / `/router auto` | Force or release a pin for the current session by writing the pin file |
| `/router judge [pull\|status\|cancel\|probe]` | Calls oMLX directly: model, latency, sample verdict |
| `/router subagents on\|off` | Toggle child-session routing in config |
| `/router version` / `/router debug` | Version, ABI, and config path; full diagnostics |
| `/router help [command]` | Command reference; naming a command prints its options |

One row per command in the `HELP` table drives the menu, `/router help`, and
`/router help <command>`, so a command cannot disappear from the menu. The menu
also exposes the subcommands — `pricing refresh`, `quality refresh`, and
`pins clear` — and the routing toggle.

Every command that takes optional parameters carries a `usage:` line with those
parameters, shown with its default output and on an unknown parameter, so a typo
reports the allowed values instead of being silently ignored. A command that
requires a subcommand and is run bare prints that command's help rather than
guessing.

The TUI part reads and writes the same config file and state files as the
adapter, so changes take effect on the next turn via the adapter's mtime check.
It lists models through its own location data and calls oMLX with `fetch`; it
never asks the server to display anything. Pin writes use the same atomic
write path as the adapter.

The CLI (`bin/omlx-router.mjs`, Bun or Node, zero dependencies) provides
`status`, `config get|set`, `history [n]`, `doctor`, `pool`, `quality`, `pricing`,
`pins`, and is the control
surface for Kilo, headless `opencode run`/`serve`, and OpenCode Desktop.

## 13. Telemetry and privacy

Decision record (JSONL):

```json
{"ts": 1763210000000, "host": "opencode", "role": "root", "agent": "build",
 "session": "9f2c1a0b3d4e", "kind": "primary", "stage": "judge/cost-first",
 "poolSize": 4, "chosen": "deepseek/deepseek-flash#high", "pinned": true,
 "source": "judge", "judge": {"used": true, "cached": false, "ms": 612, "confidence": 0.8},
 "top": [{"model": "deepseek/deepseek-flash", "score": 0.82, "costUsd": 0.0041}],
 "optimiser": {"before": 18400, "after": 18400, "parts": 0, "overflow": false},
 "applied": "same-turn", "error": null}
```

Session identifiers are SHA-256 hashes (first 12 hex). **No prompt, message, or
tool-output text is stored.** The only text leaving the machine is the truncated
judge prompt sent to the configured oMLX base URL (localhost by default); this is
stated in the README. API keys are never logged.

`/router stats` aggregates decisions, judge hit rate/timeouts, switches, pin
retention, average pruning, and per-agent breakdown.

## 14. Kilo shim

- One default export: V2 reads `id`/`setup`, Kilo calls `server()`.
- `chat.message`: route, then switch with the SDK's generic transport:
  `client.session._client.post({url: "/api/session/{sessionID}/model", path:
  {sessionID}, body: {model: {providerID, id}}})`. The probe confirmed a 204 and
  that the **current** turn keeps its model, so the switch applies at the next
  boundary. `chat.params` passes through;
  `experimental.chat.messages.transform` applies the optimiser plan.
- Decisions record `applied: "boundary"` when the model switch cannot affect the
  in-flight turn. The README documents this limitation.
- If the switch API is unavailable, the shim logs once, sets status to
  `kilo: unsupported`, and performs no routing rather than pretending.
- Subagents are detected through `parentID` from the client session API.
- No commands and no TUI in Kilo.

## 15. Failure modes

| Failure | Behaviour |
|---|---|
| `core.wasm` missing / ABI mismatch / trap | Disable routing, status error, pass-through |
| `optimise` plan fails to apply | Skip pruning, log, send unchanged messages |
| Judge timeout / HTTP / parse error | Heuristic verdict; record `judge.used=false` |
| oMLX model list unavailable | `judge.model` used as-is; if absent, heuristics |
| `switchModel` rejected | Log, keep pin, retry next turn; repeated failure disables routing |
| Config invalid JSON | Defaults + status warning; never crash |
| Pin/state write fails | Continue in memory, warn in status |
| `session.get` fails | Treat as root, no agent metadata |
| `ctx.session.synthetic` triggers a turn | Not used; TUI displays output, CLI prints it |
| Router disabled | Hooks registered but no decisions; host behaviour unchanged |

## 16. Testing

- **Rust unit/property**: envelope, triage, pool filters, scoring determinism and
  gate correctness, pin transitions (no flip-flop loops, forced wins, compaction
  reset), optimiser (fits budget, idempotent, protected parts, overflow), serde.
- **WASM bridge (Bun)**: alloc/dealloc, real `route`/`optimise`, malformed JSON,
  ABI mismatch, trap ⇒ pass-through.
- **Adapter (Bun)**: fake host context + fake `fetch`: root turn, subagent first
  turn, user override, judge timeout/cache, compaction reset, pruning
  application, command output, config seeding, state files.
- **CI**: rustfmt, clippy `-D warnings`, `cargo test`, wasm build
  (`wasm32-unknown-unknown`, `wasm-opt -Oz` in CI), `bun test`, wasm size gate
  (<600 KB). No network calls; judge is mocked.
- **Manual E2E**: probe script first, then `scripts/e2e.sh` against real oMLX.

## 17. Packaging and repository

- `package.json`: name `@231self/opencode-omlx-router`, version `0.1.0`, `type: module`,
  `exports { ".": "./src/index.js", "./tui": "./src/tui.js" }`,
  `bin { "omlx-router": "./bin/omlx-router.mjs" }`,
  `files ["src", "dist/core.wasm", "bin", "README.md", "LICENSE"]`,
  license Apache-2.0, engines Node >=22.
- Scripts: `build:wasm`, `build`, `test`, `test:rust`, `check`, `prepack`.
- `rust-toolchain.toml` pins stable + `wasm32-unknown-unknown`.
- `dist/core.wasm` is committed for git installs; `prepack` rebuilds it; CI
  smoke-tests it and enforces the size gate (byte-for-byte reproducibility is
  not promised).
- Install: `opencode plugin add @231self/opencode-omlx-router` (or a `plugins` entry),
  `kilo plugin @231self/opencode-omlx-router`; local development via a `plugins` path
  entry after `bun run build:wasm`.
- Repository: jj colocated with git, bookmark `main`, public, org `231self`,
  topics `opencode`, `kilo`, `plugin`, `llm-router`, `omlx`, `mlx`, `wasm`.

## 18. Documentation

`README.md` must stand alone for users, and includes: what it does, architecture
diagram, requirements, install for OpenCode and Kilo, pulling the judge model in
oMLX, quick start, full configuration reference with defaults, pool sources,
policies, routing pipeline, pinning and optimiser rules, **subagent policy with
examples**, commands/TUI/CLI, decision log fields and privacy, Kilo limitations,
troubleshooting, development (jj, build, tests, probe), license.

Depth lives in `docs/architecture.md`, `docs/protocol.md` (ABI + JSON),
`docs/configuration.md`, `docs/development.md`; the README links them but keeps
the essentials inline. `config.example.json` ships with the repo.

## 19. Milestones

| Milestone | Content | Exit criteria |
|---|---|---|
| M0 probe | Throwaway V2 plugin + Kilo shim logging hooks and switching models | Same-turn switch semantics, subagent behaviour, plain-object export, and Kilo switch API are known |
| M1 skeleton | Repo, Rust ABI, wasm build, adapter loader, config/state, `/router status`, CLI status | `bun test` + `cargo test` green; status works in OpenCode |
| M2 routing | Pool, judge, scoring, pinning, switchModel; root sessions | Real oMLX + favorites pool routes a session; decisions logged |
| M3 optimiser | `optimise` core, plan application, stats | Oversized turn is pruned to budget without touching protected parts |
| M4 subagents | Role detection, agent policy, independent pins, attribution | Child session routes independently; stats break down by agent |
| M5 Kilo | V1 shim, boundary switching, transform pruning, limitations | Kilo session routes at the next boundary or reports unsupported |
| M6 surfaces | Commands, TUI picker, CLI, stats/history/explain | All commands documented and exercised |
| M7 release | Docs, CI, npm pack, tag | README complete; CI green; `npm pack` installs in both hosts |

## 20. Probe results and remaining validation

The M0 probe ran on 2026-11-15; full evidence is in `docs/development.md`.

| Question | Result |
|---|---|
| `switchModel` in the `prompt` hook affects the in-flight root turn (V2) | **Yes** — same-turn assistant message and context use the new model |
| Same for a subagent's first turn | **Yes** — child has `parentID`, agent `explore`, switched same turn, parent unaffected |
| Plain-object export without `@opencode/plugin` (server part) | **Yes** |
| Kilo: `chat.message` before resolution, usable switch API | **Yes** — `chat.message` is pre-request; `client.session._client.post("/api/session/{id}/model")` returns 204 but applies to the next boundary |
| `ctx.session.synthetic` without starting a model turn | **No** — it starts a turn; command output moved to the TUI part and CLI (§12) |
| One object export (`{ id, setup, server }`) loads in both hosts | **Yes** — V2 reads `setup`, Kilo calls `server()` |

Remaining before M6: confirm the TUI part also loads as a plain object without
`@opencode/plugin/tui`; if it does not, import it there only (still no
TypeScript).

## 21. License

Apache-2.0. See `LICENSE`.
