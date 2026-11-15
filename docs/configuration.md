# Configuration reference

One file is authoritative: `~/.config/omlx-router/config.json`. Plugin options in
`opencode.jsonc` (or Kilo config) are read **once** to seed the file when it does
not exist; afterwards the file wins, so manual edits and the TUI/CLI always take
effect. `/router status` warns if the option seed and the file drift.

Environment overrides (useful for tests and multi-profile setups):

| Variable | Effect |
|---|---|
| `OMLX_ROUTER_CONFIG` | Config file path |
| `OMLX_ROUTER_STATE` | State root (default `~/.local/state/omlx-router`) |
| `OMLX_ROUTER_HOST` | CLI default host (`opencode` or `kilo`) |
| `OMLX_ROUTER_FAVORITES` | Host model-state file used for favorites |

## Top level

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Master switch; hooks stay registered but do nothing |
| `policy` | `"cost"` | `cost`, `quality`, or `latency` |
| `debug` | `false` | Adapter debug logs (never prompt text) |

## `telemetry`

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Record per-turn timing in `turns.jsonl` |

Telemetry subscribes to the host's public events and writes one record per
turn: routing time (including the local judge), remote model-call time, tool
time, time to first token, steps, tokens, and cost. It stores a hashed session
id and model ids, never prompt or tool text. Disable it if you do not want the
extra file; decision records still contain `timing.routeMs/judgeMs`.

## `pool`

| Key | Default | Notes |
|---|---|---|
| `source` | `"favorites"` | `favorites`, `list`, or `available` |
| `models` | `[]` | Used with `source: "list"`; `provider/model` or `provider/model#variant` |
| `include` | `[]` | Glob patterns force-added after source resolution |
| `exclude` | `[]` | Glob patterns dropped; matched against `provider/model` and the bare id |
| `maxModels` | `8` | Candidate table size sent to the judge |
| `requireTools` | `true` | Drop models without tool calling |
| `minContext` | `32000` | Minimum context window |

Favorites live in the host state file: `~/.local/state/opencode/model.json` or
`~/.local/state/kilo/model.json`, field `favorite`. Empty favorites fall back to
all available models and emit a warning in `/router pool`.

## `judge`

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Disable to use deterministic triage only |
| `baseURL` | `http://127.0.0.1:1234/v1` | oMLX OpenAI-compatible endpoint |
| `model` | `"auto"` | `auto` picks the smallest advertised model by parameter size |
| `apiKey` | `"{env:OMLX_API_KEY}"` | `{env:NAME}` expanded; empty means no Authorization header |
| `timeoutMs` | `5000` | Per-request timeout; the 4B judge is usually under 1 s, but cold/first calls can take 3-4 s. Use 20000+ for a large judge |
| `cacheTtlMs` | `600000` | Verdict cache TTL |
| `cacheSize` | `128` | LRU entries |

### `judge.provision`

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Allows the plugin to *offer* a download; consent is always required |
| `repo` | `mlx-community/Qwen3-4B-Instruct-2507-4bit` | Recommended judge |
| `adminApiKey` | `{env:OMLX_ADMIN_API_KEY}` | oMLX main key; sub-keys cannot administer downloads |
| `readSettingsKey` | `true` | Fall back to `auth.api_key` in `~/.omlx/settings.json` |
| `hfToken` | `{env:HF_TOKEN}` | Optional, for gated Hugging Face repos |
| `allowNonMlx` | `false` | Permit repositories that do not look MLX-compatible |

No download starts without a TUI confirmation or a CLI `y` / `--yes`. Downloads
use oMLX's admin API (`/admin/api/hf/*`), so the model appears in oMLX's model
directory and is rediscovered on completion. The admin key is never logged.

## `pin`

| Key | Default | Notes |
|---|---|---|
| `switchThreshold` | `0.12` | Keep the incumbent unless the challenger wins by more |
| `idleTtlMs` | `300000` | Re-route after this much idle time |
| `flipFlopTurns` | `3` | Do not switch back to a model used in the last N turns |
| `cacheHitRatio` | `0.8` | Assumed cache-read share when costing a pinned model |

## `optimiser`

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | No pruning when false (token measurement continues) |
| `reserveOutputTokens` | `8192` | Capped by the model's output limit |
| `safetyTokens` | `1024` | Extra headroom |
| `maxToolTokens` | `2000` | Outputs above this are truncated |
| `keepRecentToolOutputs` | `3` | Never stubbed |
| `keepRecentTurns` | `2` | Never stubbed or truncated |

## `limits`

| Key | Default | Notes |
|---|---|---|
| `shortfallTolerance` | `0.2` | Candidate excluded when required quality exceeds it by more |
| `allowLocalForComplexity` | `2` | Local models are blocked above this complexity unless overridden |
| `expectedOutputTokens` | `1200` | Cost estimate baseline; agentic turns use `max(expected, input/12)` |
| `contextFitRatio` | `0.9` | Required input must fit within this share of the window |

## `quality` and `latency`

```jsonc
{
  "quality": { "overrides": { "omlx/Qwen3.8-27B-MLX-4bit": 0.72 } },
  "latency": {
    "overrides": { "openai/gpt-6.1-sol": 1400 },
    "localProviders": ["omlx"]
  }
}
```

Quality is a documented heuristic (price percentile, parameter size, context
size, reasoning support), not a benchmark. Zero-cost local models default to
0.35. Overrides are keyed `provider/modelID`.

## `subagents`

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Route child sessions |
| `overrideExplicitModel` | `false` | When false, an agent's configured model is a forced pin |
| `default` | `{policy:"cost", qualityFloor:0}` | Fallback policy for children |
| `agents` | see below | Per-agent policy |

```jsonc
{
  "subagents": {
    "agents": {
      "explore": { "policy": "latency", "qualityFloor": 0.45, "minContext": 128000 },
      "general": { "policy": "cost",    "qualityFloor": 0.55 },
      "review":  { "policy": "quality", "qualityFloor": 0.75 },
      "plan":    { "policy": "quality", "qualityFloor": 0.8 }
    }
  }
}
```

Per-agent keys: `policy`, `qualityFloor`, `minContext`, `requireTools`,
`maxComplexity` (local-model ceiling).

## Examples

Explicit two-model pool, cost-first, 4B judge:

```jsonc
{
  "policy": "cost",
  "pool": {
    "source": "list",
    "models": ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]
  },
  "judge": { "model": "Qwen3-4B-Instruct-2507-4bit", "timeoutMs": 5000 },
  "quality": { "overrides": { "deepseek/deepseek-v4-pro": 0.9 } }
}
```

All enabled models, latency-first, local excluded:

```jsonc
{
  "policy": "latency",
  "pool": { "source": "available", "exclude": ["omlx/*"] }
}
```

Favorites with a local model force-added:

```jsonc
{
  "pool": {
    "source": "favorites",
    "include": ["omlx/*"],
    "minContext": 128000
  },
  "quality": { "overrides": { "omlx/Qwen3.8-27B-MLX-4bit": 0.72 } }
}
```
