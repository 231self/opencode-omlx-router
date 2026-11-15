# WASM protocol

`dist/core.wasm` is built from `core/` for `wasm32-unknown-unknown`. There are no
imports; every input is JSON copied through the exported allocator.

## Exports

```text
abi_version() -> u32          // 1
alloc(len: u32) -> ptr        // null for len 0
dealloc(ptr: u32, len: u32)
result_len() -> u32
route(ptr: u32, len: u32) -> ptr
optimise(ptr: u32, len: u32) -> ptr
```

The result pointer points into a module-owned buffer and stays valid until the
next call. The adapter copies `result_len()` bytes immediately, then decodes
UTF-8 JSON.

Malformed input, an ABI mismatch, or a trap never fails a turn: the adapter logs
and passes the turn through unchanged.

## `route`

Input (abridged; camelCase, unknown fields ignored):

```json
{
  "abi": 1,
  "nowMs": 1763210000000,
  "host": "opencode",
  "kind": "primary",
  "role": "root",
  "session": {
    "hash": "9f2c1a0b3d4e",
    "parentHash": null,
    "agentID": "build",
    "agentMode": "primary",
    "agentModel": null,
    "currentModel": { "providerID": "deepseek", "id": "deepseek-flash", "variant": "default" },
    "parentModel": null
  },
  "turn": {
    "promptText": "fix the parser and run tests",
    "promptTokens": 12,
    "images": 0,
    "lastContextTokens": 18400,
    "toolFailures": 0,
    "turnClassHint": null
  },
  "pool": [
    {
      "providerID": "deepseek",
      "modelID": "deepseek-flash",
      "name": "DeepSeek V4.1 Flash",
      "variant": "default",
      "local": false,
      "cost": [{ "input": 0.2, "output": 0.8, "cache": { "read": 0.05, "write": 0.2 } }],
      "limit": { "context": 262144, "output": 131072 },
      "capabilities": { "tools": true, "input": ["text", "image"], "output": ["text"] },
      "reasoning": true,
      "status": "active",
      "qualityOverride": null,
      "latencyOverrideMs": null
    }
  ],
  "settings": { "enabled": true, "policy": "cost", "…": "config" },
  "pin": null,
  "judge": { "verdict": null, "cached": false, "unavailable": false },
  "stats": { "decisions": 0, "switches": 0 }
}
```

Response — decide:

```json
{
  "abi": 1,
  "action": "decide",
  "decision": {
    "providerID": "deepseek",
    "id": "deepseek-flash",
    "variant": "default",
    "source": "judge",
    "reason": "first-turn",
    "pinned": false,
    "complexity": 3,
    "turnClass": "agentic",
    "confidence": 0.8,
    "top": [{ "providerID": "deepseek", "id": "deepseek-flash", "score": 0.664, "costUsd": 0.0007 }]
  },
  "pin": { "model": { "providerID": "deepseek", "id": "deepseek-flash" }, "since": 0, "switchCount": 1, "…": "state" },
  "log": { "ts": 0, "chosen": "deepseek/deepseek-flash", "judge": { "used": true, "confidence": 0.8 }, "top": [] },
  "state": { "decisions": 1, "switches": 1 },
  "envelope": { "turnClass": "agentic", "complexityHint": 3, "signals": {} }
}
```

Response — need a verdict:

```json
{
  "abi": 1,
  "action": "need_judge",
  "judgeRequest": { "prompt": "You classify one turn…", "cacheKey": "0123456789abcdef" },
  "pin": null,
  "state": { "decisions": 0, "switches": 0 },
  "envelope": { "turnClass": "agentic" }
}
```

The adapter checks its LRU cache by `cacheKey`; on a miss it calls oMLX, then
calls `route` again with `judge.verdict` (and `cached` set). If the call fails it
sets `judge.unavailable: true` and the core uses the heuristic verdict.

Response — skip:

```json
{ "abi": 1, "action": "skip", "reason": "no_pool", "envelope": {}, "log": {}, "state": {} }
```

Skip reasons: `disabled`, `subagents_disabled`, `no_pool`, `no_candidates`,
`abi_mismatch`, `invalid_input`.

## `optimise`

```json
{
  "abi": 1,
  "model": { "label": "deepseek/deepseek-flash", "limit": { "context": 128000, "output": 8192 } },
  "settings": {
    "reserveOutputTokens": 8192,
    "safetyTokens": 1024,
    "maxToolTokens": 2000,
    "keepRecentToolOutputs": 3,
    "keepRecentTurns": 2
  },
  "messages": [
    {
      "index": 0,
      "role": "assistant",
      "parts": [
        { "index": 0, "type": "tool", "tool": "read", "tokens": 8200, "text": "…" }
      ]
    }
  ],
  "systemTokens": 1200
}
```

Response:

```json
{
  "abi": 1,
  "plan": [
    { "message": 0, "part": 0, "action": "truncate", "headChars": 4800, "tailChars": 3200, "marker": "\n\n[...truncated ~6200 tokens...]\n\n" },
    { "message": 2, "part": 1, "action": "stub", "placeholder": "[omlx-router: pruned bash output, ~900 tokens omitted to fit … context]", "keepHeadChars": 200 }
  ],
  "stats": { "beforeTokens": 131000, "afterTokens": 118400, "partsPruned": 2, "overflow": false }
}
```

Actions are applied in order. Under budget returns `plan: []` with equal
`beforeTokens`/`afterTokens`. If the request cannot fit after all safe actions,
the response is `plan: []`, `overflow: true`; the adapter does not prune, clears
the pin, and lets the host compact.
