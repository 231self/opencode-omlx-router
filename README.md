# opencode-omlx-router

Per-turn model routing for [OpenCode V2](https://opencode.ai) and
[Kilo](https://kilo.ai), decided by a small local model served by
[oMLX](https://github.com/jundot/omlx), with a context optimiser that keeps each
turn inside the chosen model's budget.

> **Status: release candidate (v0.1.0).** Routing, the context optimiser,
> subagent policy, the TUI `/router` surface, the CLI, and the Kilo shim are
> implemented and tested. Release packaging (CI, npm) is the remaining step;
> install commands do not work until the first publish. Design of record:
> [`docs/specs/2026-11-15-opencode-omlx-router-design.md`](docs/specs/2026-11-15-opencode-omlx-router-design.md).

## Why

A coding agent makes you pick one model for a whole session. A one-line question
then costs frontier-model tokens, while a hard refactor on a small model burns
retries. This plugin routes **each turn** to the model that fits it, from a pool
you control.

It ports the transferable ideas from
[`pi-smart-router`](https://github.com/beettlle/pi-smart-router) — turn envelope,
deterministic triage, context-fit gate, cache-aware pinning, loop escalation,
decision logging — and drops the heavy machinery (HyDRA/ONNX embeddings,
benchmark calibration, virtual cost, planning delegate).

## How it works

```text
user turn
  → host hook (OpenCode V2 prompt hook / Kilo chat.message)
  → pool: favorites · explicit list · all available models
  → hard gates: tools · vision · context fit · not deprecated
  → deterministic triage (cheap early exits)
  → oMLX judge: complexity, task, reasoning need, confidence   [1.5 s budget]
  → scoring under your policy: cost-first · quality-first · latency-first
  → pin policy: keep the incumbent unless the challenger clearly wins
  → session.switchModel(...)
  → context optimiser: prune only when over the chosen model's budget
  → decision log + /router status, history, explain
```

The routing brain is a Rust core compiled to WebAssembly and shipped in the
package; it is deterministic, has no I/O, and is unit-tested on its own. Plain
JavaScript adapters wire it to each host. There is **no TypeScript** in this
project and no Python runtime requirement.

The only model call the plugin makes for a decision is a short JSON-verdict
prompt to the oMLX endpoint you configure (localhost by default). If oMLX is
slow or down, deterministic heuristics take over and routing continues.

## Documentation

- [Architecture](docs/architecture.md) — adapter, WASM core, turn flow, subagents, pinning, optimiser.
- [WASM protocol](docs/protocol.md) — ABI, request/response JSON, need-judge flow, optimiser plans.
- [Configuration reference](docs/configuration.md) — every key, defaults, examples.
- [Troubleshooting](docs/troubleshooting.md) — symptoms, evidence, reset.
- [Building and releasing](docs/releasing.md) — build, pack, publish, tag, consumer install.
- [Design spec](docs/specs/2026-11-15-opencode-omlx-router-design.md) and
  [implementation plan](docs/plans/2026-11-15-implementation.md).
- [Development notes](docs/development.md) — probe results, verification, limits.

## Requirements

| Requirement | Notes |
|---|---|
| [OpenCode](https://opencode.ai) ≥ 2.3 | First-class; V2 plugin API |
| [Kilo CLI](https://kilo.ai) ≥ 7.6.2 | Best-effort mode; see [Kilo limitations](#kilo-limitations) |
| [oMLX](https://github.com/jundot/omlx) | OpenAI-compatible server, default `http://127.0.0.1:1234/v1` |
| A small judge model in oMLX | e.g. a ~4B instruct model; see [Choose a judge](#choose-a-judge) |
| Node/Bun | Provided by OpenCode and Kilo; nothing extra to install |

No Rust toolchain is needed to install a released package. Building from source
requires Rust with the `wasm32-unknown-unknown` target.

## Install

> The package is not on npm yet. Build from a checkout today; the npm commands
> work after the first publish. Release/build details:
> [docs/releasing.md](docs/releasing.md).

### OpenCode V2

```sh
opencode plugin add opencode-omlx-router
```

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-omlx-router"]
}
```

### Kilo

```sh
kilo plugin opencode-omlx-router
```

```jsonc
// ~/.config/kilo/kilo.jsonc or project kilo.jsonc
{
  "$schema": "https://app.kilo.ai/config.json",
  "plugin": ["opencode-omlx-router"]
}
```

### From a checkout (works before npm publish)

```sh
git clone https://github.com/231self/opencode-omlx-router
cd opencode-omlx-router
bun install
bun run build:wasm       # needs Rust with wasm32-unknown-unknown
```

Then point the host at the checkout:

```jsonc
// OpenCode
{ "plugins": ["/absolute/path/to/opencode-omlx-router"] }
```

```jsonc
// Kilo
{ "plugin": ["/absolute/path/to/opencode-omlx-router/src/index.js"] }
```

Kilo applies a decision at the next request boundary; see
[Kilo limitations](#kilo-limitations).

## Choose a judge

The judge is a small instruct model served by oMLX. It answers one short JSON
question per turn: how complex is this turn, does it need tools/vision/long
context, how much reasoning, and how confident is it.

A ~4B model is the sweet spot: fast enough for a per-turn hop, reliable enough
for structured output. Recommended: a Qwen3-4B-class MLX instruct model, pulled
through the oMLX app's model browser. A 1.7B-class model works for coarse
classification; a 27B model works but adds real prefill cost to every turn.

The plugin defaults to `judge.model: "auto"`, which picks the smallest model the
oMLX `/v1/models` endpoint advertises. Set it explicitly if you run several small
models:

```json
{ "judge": { "model": "Qwen3-4B-Instruct-2507-4bit" } }
```

Verify with:

```text
/router judge
```

This prints the selected model, a sample verdict, and the round-trip latency.

## Quick start

1. Install the plugin and configure the judge (above).
2. Ask for a status: `/router` (OpenCode) or `omlx-router status` (any host).
3. Talk normally. Every turn is routed; the session's model changes to the
   chosen one, and `/router explain` shows why.
4. Choose a policy: `/router policy` prints the options; pick one with
   `/router policy quality` (or use the TUI picker described below).

By default the pool is your **favorites** in the host's model picker
(`Ctrl+F` in the OpenCode model dialog). To route across everything you have
enabled instead, set `pool.source` to `available`; to pin an exact list, use
`pool.source: "list"` with `pool.models`.

## Configuration

One file is the source of truth: `~/.config/omlx-router/config.json`. Plugin
options in `opencode.jsonc` / Kilo config are read **once** to seed the file when
it does not exist; afterwards the file wins, so manual edits and the TUI picker
always behave predictably. `/router status` warns if the two drift.

Full example: [`config.example.json`](config.example.json).

```jsonc
{
  "enabled": true,
  "policy": "cost",                       // cost | quality | latency

  "pool": {
    "source": "favorites",                // favorites | list | available
    "models": [],                         // used when source = list
    "include": [],                        // glob patterns, force-add
    "exclude": [],                        // glob patterns, drop
    "maxModels": 8,                       // judge table size
    "requireTools": true,
    "minContext": 32000
  },

  "judge": {
    "enabled": true,
    "baseURL": "http://127.0.0.1:1234/v1",
    "model": "auto",                      // or an explicit oMLX model id
    "apiKey": "{env:OMLX_API_KEY}",       // oMLX may not require one
    "timeoutMs": 1500,
    "cacheTtlMs": 600000,
    "cacheSize": 128
  },

  "pin": {
    "switchThreshold": 0.12,              // keep incumbent unless challenger wins by this
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

  "quality": { "overrides": {} },         // {"provider/model": 0.0..1.0}
  "latency": { "overrides": {}, "localProviders": [] },

  "subagents": {
    "enabled": true,
    "overrideExplicitModel": false,
    "default": { "policy": "cost", "qualityFloor": 0.0 },
    "agents": {
      "explore": { "policy": "latency", "qualityFloor": 0.45, "minContext": 128000 },
      "general": { "policy": "cost",    "qualityFloor": 0.55 },
      "review":  { "policy": "quality", "qualityFloor": 0.75 },
      "plan":    { "policy": "quality", "qualityFloor": 0.8 }
    }
  },

  "debug": false
}
```

### Policies

| Policy | Weights (cost / quality / latency) | Use when |
|---|---|---|
| `cost` (default) | 0.6 / 0.3 / 0.1 | You want the cheapest model that clears the bar, escalating only when needed |
| `quality` | 0.1 / 0.8 / 0.1 | Quality matters more than spend |
| `latency` | 0.2 / 0.2 / 0.6 | Interactive work; favours local and fast cloud models |

Changing the policy clears pins so the next turn is scored from scratch.

### Pool sources

| Source | Behaviour |
|---|---|
| `favorites` | Your favourites in the host model picker, filtered against the live catalog. Empty favourites fall back to `available`. |
| `list` | `pool.models: ["provider/model", "provider/model#variant"]` |
| `available` | Every enabled chat model |

Models without tool support, deprecated models, and models that cannot fit the
turn are excluded automatically. Local models (loopback providers) are never
chosen above complexity 2 unless you raise `limits.allowLocalForComplexity` or set
a quality override.

### Quality and latency overrides

Model quality is a documented heuristic (price percentile, parameter size,
context size, reasoning support), not a benchmark. Zero-cost local models get a
default quality of 0.35. If the heuristic misjudges a model you use, override it:

```json
{
  "quality": { "overrides": { "omlx/Qwen3.8-27B-MLX-4bit": 0.72 } },
  "latency": { "overrides": { "openai/gpt-6.1-sol": 1400 } }
}
```

## Subagent routing

Subagents route independently, with their own pins, so an `explore` subagent can
run cheap and fast while the parent stays on a strong model. Detection is via the
child session's `parentID`; the agent identity comes from the session/agent
metadata. The task prompt is classified exactly like a normal turn, with the
agent's policy applied.

Resolution order:

1. An explicit model configured on the agent (respected as a forced pin unless
   `subagents.overrideExplicitModel` is `true`).
2. `subagents.agents[agentID]`.
3. `subagents.default`.
4. The global policy.

The shipped defaults map the common agents sensibly:

- `explore` — latency policy, tools required, at least 128k context: retrieval is
  fast and context-heavy, not deeply clever.
- `general` — cost policy with a 0.55 quality floor.
- `review`, `plan` — quality policy with high floors.

Loop escalation is per session: a subagent that keeps hitting the same tool error
escalates itself to a stronger model and does not drag the parent with it. On a
score tie, a child prefers the parent's current model to reuse the prompt cache.

`/router history` marks subagent decisions and `/router stats` breaks down
switches, judge usage, pruning, and escalation by agent.

## Pinning: how "per turn" stays cache-aware

The router decides every turn, but does not switch on noise. A session pins its
model and keeps it while the pin is still adequate and the best alternative does
not beat it by `pin.switchThreshold`. A pin is broken by a capability or context
gate failure, a complexity jump of two or more, repeated tool failures, context
overflow, a policy change, or idling past the TTL. A flip-flop guard prevents
bouncing back to a model used in the last few turns.

If you pick a model yourself (`/model`), that is respected as a forced pin until
you run `/router auto`, the session compacts, or the model disappears. Compaction
always clears the pin so the next turn re-routes.

## Context optimiser

When the assembled request fits the chosen model, **nothing is changed** —
cache-safe by construction. When it does not fit, the optimiser works in order
and stops as soon as the request fits:

1. Deduplicate identical tool outputs, keeping the newest.
2. Truncate tool outputs above `optimiser.maxToolTokens` to 60% head + 40% tail,
   with a marker.
3. Stub tool outputs older than the last `keepRecentToolOutputs`, largest first,
   with a marker naming the tool and the omitted token count.

System instructions, user text, the first user message, recent turns, and error
outputs are protected. If pruning cannot fit the request, the optimiser stops,
reports `overflow`, clears the pin, and lets OpenCode compact; the next turn
routes to a model with a larger window. Compaction, title, and transient
generation requests are never pruned or routed.

## Commands

The `/router` surface runs in the **OpenCode TUI** (the plugin's TUI part), so
status and settings never cost a model turn. The same actions are available in
the CLI for headless `opencode run`/`serve`, OpenCode Desktop, and Kilo.

| Command | Purpose |
|---|---|
| `/router` | Status dialog: state, policy, pool, pins, last decision, judge health |
| `/router on` / `/router off` | Enable or disable routing |
| `/router policy` | Interactive picker for `cost` / `quality` / `latency`; clears pins |
| `/router pool` | Resolved models with inferred quality/cost/local flags and exclusion reasons |
| `/router history [n]` | Recent decisions, including subagents |
| `/router explain` | Full trace of this session's last decision |
| `/router pin` / `/router auto` | Force or release a model pin for this session |
| `/router judge` | Probe oMLX directly: model, latency, sample verdict |
| `/router subagents on\|off` | Toggle subagent routing |

A palette entry, **"oMLX Router: settings"**, opens the same dialog without
typing a command.

### CLI

Works in any host, including Kilo, headless OpenCode, and CI:

```sh
omlx-router status
omlx-router doctor
omlx-router pool
omlx-router history 20
omlx-router config get policy
omlx-router config set policy quality
```

## Kilo limitations

Kilo 7.6.2 uses the V1 plugin API, which has no per-request model hook. The shim
switches the session model at the next request boundary; a decision therefore
applies to the following turn, and the decision log records
`applied: "boundary"`. If Kilo's model-switching API is unavailable to plugins,
the shim reports `kilo: unsupported` and stays out of the way rather than
pretending to route. Kilo has no `/router` command and no TUI settings dialog;
use the `omlx-router` CLI and `config.json`.

## Privacy

- Decision records store **no prompt, message, or tool-output text** — only
  signals, model ids, scores, timings, and a hashed session id.
- The only text that leaves the machine is the truncated turn summary in the
  judge request, sent to the `judge.baseURL` you configure (localhost by
  default).
- API keys are read from your config/env and never logged.
- State is local: `~/.local/state/omlx-router/<host>/`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Routing does nothing | `/router status`: enabled? pool empty? judge errors? |
| Judge timeouts | `/router judge`; raise `judge.timeoutMs`, use a smaller judge model |
| Wrong model chosen | `/router explain`; adjust `quality.overrides`, policy, or pool |
| Model switching visibly lags | Kilo boundary behaviour, or a host that rejects the switch; check the decision log |
| Context overflow | The optimiser reports `overflow`; raise the pool's context floor or reduce `reserveOutputTokens` |
| Config ignored | The file wins after first run; check `~/.config/omlx-router/config.json` and the drift warning in status |

## Development

```sh
bun install
bun run build:wasm     # cargo build --target wasm32-unknown-unknown --release
bun test               # adapter + WASM bridge tests
bun run test:rust      # cargo test
bun run check          # fmt, clippy, tests, size gate
```

The repository uses [jj](https://github.com/jj-vcs/jj) on top of git
(colocated). Conventional commits, `main` is the release bookmark.

Layout:

```text
core/            Rust decision engine (no I/O), compiled to dist/core.wasm
src/             plain-JS host adapters, judge client, state, commands
src/tui.js       OpenCode TUI /router command + palette (plain JS)
bin/             omlx-router CLI
tests/           Bun tests and fixtures
docs/            design spec and deeper docs
```

## License

Apache-2.0. See [LICENSE](LICENSE).
