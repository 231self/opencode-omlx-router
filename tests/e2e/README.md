# Prompt tests

These are live integration tests. Each step sends a real prompt to a real host
(OpenCode V2 or Kilo), while the router's judge is a deterministic local stub.
The harness then asserts:

1. the decision record (model, source, reason, pin state, policy, stage), and
2. the model the host **actually used** for the turn (exported from the host
   session), and
3. for Kilo, that the current turn stayed on the old model and the session
   moved to the new one at the boundary, and
4. for OpenCode, that `turns.jsonl` has a timing record with routing, judge,
   remote model, and tool time. The PASS line prints the judge/model split.

Unit tests cover the Rust core and the adapters with fakes. These tests cover
the parts that only fail in a real host: hook wiring, `switchModel`, session
state, pin durability across turns, subagent sessions, and boundary semantics.

## Requirements

- OpenCode ≥ 2.3 and/or Kilo ≥ 7.6.2 on `PATH`
- Model credentials for the pool (`deepseek/deepseek-flash` and
  `deepseek/deepseek-v4-pro` by default)
- Bun
- For `--real-judge`: oMLX at `http://127.0.0.1:1234/v1` with a judge model

No oMLX model is needed for the stub scenarios.

## Run

```sh
bun run test:e2e                 # all stub scenarios (OpenCode + Kilo)
bun run test:e2e:list            # list scenario ids
bun tests/e2e/run.mjs --host opencode
bun tests/e2e/run.mjs --only pin-holds,complexity-jump
bun tests/e2e/run.mjs --keep     # keep temp workspaces
bun run test:e2e:live            # one prompt through the real oMLX judge
bun tests/e2e/run.mjs --package /path/to/node_modules/@231self/opencode-omlx-router
```

`--package` points the host config at an installed package instead of this
checkout, which verifies the published tarball (including `dist/core.wasm`)
rather than the source tree.

Each run prints one line per step and writes a temp workspace per scenario. On
failure the workspace is kept and printed; on success it is removed unless
`--keep` is set.

## Isolation

- A fresh temp workspace per scenario, with its own `opencode.jsonc` /
  `kilo.jsonc` pointing at this checkout.
- `OMLX_ROUTER_CONFIG` and `OMLX_ROUTER_STATE` point inside the workspace, so
  the test never reads or writes `~/.config/omlx-router` or
  `~/.local/state/omlx-router`.
- The child process environment is scrubbed of the parent OpenCode session
  (`OPENCODE_*`, `KILO_*`, `AI_AGENT`, `PWD`, `OLDPWD`, `INIT_CWD`). Without
  this, `opencode run` reuses the parent project location instead of the
  fixture workspace.
- The judge stub listens on a random loopback port. `judge-unreachable` points
  at a closed port on purpose.

## Scenarios

| Id | Host | What it proves |
|---|---|---|
| `trivial-triage` | OpenCode | Short turns skip the judge and use the triage path. |
| `judge-cost` | OpenCode | A judged medium turn chooses the cheap model under cost policy. |
| `quality-gate` | OpenCode | Quality policy selects the stronger model and applies it same-turn. |
| `latency-policy` | OpenCode | Latency overrides can beat both price and quality. |
| `pin-holds` | OpenCode | The incumbent survives a higher-scoring challenger inside the switch threshold. |
| `complexity-jump` | OpenCode | A two-step upward jump breaks the pin and escalates. |
| `judge-unreachable` | OpenCode | A dead judge endpoint falls back to deterministic heuristics. |
| `judge-malformed` | OpenCode | Unparsable output is retried once, then falls back. |
| `judge-underclassifies` | OpenCode | A deliberately weak verdict is raised to the signal floor before routing. |
| `judge-underclassifies-multifile` | OpenCode | A three-file plan is raised to complexity 4 before routing. |
| `user-override` | OpenCode | An explicit `--model` becomes a forced pin that bypasses the judge and persists. |
| `favorites-pool` | OpenCode | The default `favorites` pool source reads the host favorites file. |
| `subagent-explore` | OpenCode | A child session uses the `explore` agent's latency policy independently. |
| `kilo-boundary` | Kilo | The current turn uses the old model; the decision applies at the next boundary. |
| `disabled` | OpenCode | The master switch leaves the host untouched and writes no decision. |
| `live-judge` | OpenCode | The real oMLX judge returns a verdict and routes the turn (needs `--real-judge`). |

The scenario catalog is in [`scenarios.mjs`](scenarios.mjs). The default pool is
DeepSeek Flash and Pro with quality overrides `0.55` and `0.8`; the overrides
make the cost/quality/latency choices deterministic instead of relying on the
host's model-name heuristics.

## Adding a scenario

1. Add an entry to `SCENARIOS` with `id`, `host`, optional `config` overrides,
   and `steps`.
2. Each step has a `prompt`, an optional `judge` verdict (or `"malformed"` /
   `null`), optional `model`/`agent`/`auto`/`timeoutMs`, and `expect`.
3. `expect.decisions` is matched by `role` (and `agent` when given). Fields:
   `chosen`, `source`, `reason`, `pinned`, `applied`, `policy`, `stage`,
   `complexity`, `judgeUsed`, `assistantModel`, `assistantMatchesChosen`,
   `sessionModel`.
4. For Kilo boundary steps, set `assistantMatchesChosen: false` when the
   current turn intentionally uses the previous model.

Use a prompt with a code marker (for example `.rs` or `.js`) when the turn must
reach the judge; short marker-free prompts take the triage path by design.

## What the first run found

The initial suite caught four adapter/core bugs that unit tests with fakes did
not:

- The OpenCode V2 `context` event carries `{providerID, id}` but no limits.
  The optimiser treated every model as zero-context and returned `overflow`,
  which also cleared the pin.
- Context-hook writes and prompt-hook writes race on the same pin file, so a
  context write could erase a freshly chosen model.
- A downward complexity change was treated as a "jump" and forced a switch,
  and a same-model selection could be recorded as a switch.
- A rejected `switchModel` still recorded `applied: "same-turn"`.
- `Inspect` matched the `spec` planning marker and classified a simple
  inspection as planning; marker matching now uses word boundaries.

All four are fixed; the scenarios above are the regression tests.
