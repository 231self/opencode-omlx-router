# Development notes

## M0 probe results (2026-11-15)

Throwaway probes under `spikes/` (gitignored). Hosts: OpenCode `2.3.0`,
Kilo `7.6.2`. Evidence is from plugin logs, session/assistant message records,
and `kilo export`.

### T0.2 — does `switchModel` in the `prompt` hook affect the in-flight turn? (V2)

**Yes.**

- Session started on `opencode/iceman-free`.
- The `prompt` hook called
  `ctx.session.switchModel({sessionID, model:{providerID:"deepseek", id:"deepseek-flash"}})`.
- The `context` hook for the same turn reported
  `model: {providerID:"deepseek", id:"deepseek-flash"}`.
- The assistant message for that turn recorded `deepseek/deepseek-flash`.
- The session model afterwards was `deepseek/deepseek-flash`.

Conclusion: the V2 adapter can route the current turn with `switchModel` from
the prompt hook; no proxy is needed.

### T0.3 — plain-object export without `@opencode/plugin`

**Yes.** `export default { id: "probe.local", setup(ctx) {…} }` loaded and its
hooks ran. No import of `@opencode/plugin` was present.

### T0.4 — subagent first turn

**Yes.** OpenCode V2's `subagent` tool created a child session. For that child:

- The `prompt` hook fired with `sessionID` and `ctx.session.get` returned
  `parentID` pointing at the parent.
- `session.agent` was `"explore"` at admission time.
- The child inherited the parent's model at admission; an in-hook switch to
  `deepseek/deepseek-flash` applied to the child's **first** turn
  (`context` hook model, tools subset = 7 vs 13 for the parent).
- The parent remained on `deepseek/deepseek-v4-pro`; pins are independent as
  designed.

### T0.5 — Kilo hooks and model switching

- `chat.message` fires before the provider request with
  `{sessionID, agent, model, messageID, variant}` and a mutable
  `{message, parts}` output. `event.model` is the already-selected model.
- `chat.params` fires after model resolution. `client.session.switchModel` is
  **not** exposed on the V1 SDK client.
- The Kilo server exposes the V2-style route
  `POST /api/session/{sessionID}/model` (body
  `{model:{providerID, id, variant?}}`, 204). It is reachable from a plugin
  through the SDK's generic transport:

  ```js
  await input.client.session._client.post({
    url: "/api/session/{sessionID}/model",
    path: { sessionID },
    body: { model: { providerID, id } },
  })
  ```

- A switch made in `chat.message` returns 204 but the **current** turn still
  uses the old model (`chat.params` reports it); the session model afterwards is
  the new one. So Kilo is `applied: "boundary"`, as designed.

Side observation: Kilo's built-in title agent uses `kilo-auto/small`, a Kilo
router. It is unrelated to this plugin.

### T0.6b — one export object for both hosts

**Yes.** Kilo 7.6.2 accepts the object form `export default { id, server }`
(the V1 `server()` function) and calls it. OpenCode V2 accepts
`{ id, setup }`. A single default export containing both `setup` and `server`
therefore serves both hosts without a build step or separate entrypoint.

### T0.6 — `ctx.session.synthetic` as command output

**Not suitable.** A synthetic message is displayed but also **starts a model
turn**: after the synthetic was added, message counts grew and an assistant
message was produced. Command output must therefore not use synthetic messages.

Decision: the `/router` surface lives in the **TUI part** (slash command +
palette). The TUI reads config/state files directly, lists models through its
own location data, and calls oMLX directly for the judge probe. Headless/GUI and
Kilo use the `omlx-router` CLI. No server-side `/router` command is registered.

### Remaining probe item

- Plain-object export for the **TUI** part is not yet exercised. If
  `@opencode/plugin/tui` requires `Plugin.define`, import it there only; still no
  TypeScript. Resolved during M6.

## M2 end-to-end verification (2026-11-15)

- Pool: explicit `deepseek/deepseek-flash` and `deepseek/deepseek-v4-pro`.
- Judge: the only model loaded in oMLX at the time, Qwen3.8-27B, `model: "auto"`.
- A non-trivial planning prompt produced a judge verdict in **29.4 s** at
  confidence 0.9 and routed to `deepseek-flash`; the assistant turn used that
  model and the decision record was written with `applied: "same-turn"`.
- The 27B works but is not a sensible per-turn judge. A ~4B MLX instruct model
  is the supported configuration (README: Choose a judge).
- A short "reply with E2E_OK" turn classified as trivial and skipped the judge
  entirely (triage path), which is the intended fast path.

## Known limits at this point

- TUI `/router` is the only in-session surface; headless/Desktop use the CLI.
- Kilo applies decisions at the next request boundary (probe-confirmed).
- The Kilo message transform can only optimise when the message list carries an
  assistant model; otherwise it is a no-op.

## Repository workflow

This is a jj repository colocated with git. Use jj for every mutation:

```sh
jj st
jj describe -m "feat: …"
jj new                      # start the next change
jj bookmark set main -r @
jj git push -b main
```

Never `git commit`/`git checkout`/`git reset`. Bookmark `main` is the release
bookmark. Conventional commits.

## Build and test

```sh
bun run build:wasm     # cargo build --release --target wasm32-unknown-unknown
bun test               # adapter + WASM bridge (builds wasm first)
bun run test:rust      # cargo test
bun run check          # rustfmt, clippy -D warnings, both test suites, size gate
```

`dist/core.wasm` is committed for git installs and rebuilt by `prepack`. The
gate is 600 KiB; the current artifact is ~370 KiB.

## Adding a host

1. Build a ctx shim exposing `session.get`, `session.switchModel`, `model.list`,
   `provider.list`, and optionally `agent.get`.
2. Construct `Router({ctx, host, core, appliedMode})`; use `"boundary"` when the
   host cannot switch the in-flight turn.
3. Wire the host's prompt hook to `router.prompt`, its context/pre-dispatch hook
   to `router.context` (or `router.contextMessages` when no session id is
   available), and failure signals to `router.toolAfter`.
4. Add a host tag to the decision log and tests with a fake client.

## Prompt tests (2026-11-15)

`bun run test:e2e` starts real OpenCode V2 and Kilo sessions while a local judge
stub answers the router's verdict request. Each step asserts the decision record
and the model exported from the host session. See
[`tests/e2e/README.md`](../tests/e2e/README.md) for the scenario table.

Results on OpenCode 2.3.0 / Kilo 7.6.2 / DeepSeek Flash + Pro:

- 15 stub scenarios, 20 steps, all passing.
- Same-turn switching, cost/quality/latency policies, pin threshold, upward
  complexity jump, forced user override, subagent `explore` policy, judge
  timeout/HTTP fallback, malformed-verdict retry, disabled mode, and Kilo
  boundary semantics are all checked against the host's actual assistant model.
- `bun run test:e2e:live` routes a planning prompt through the real judge. With
  the 27B it took 8.9 s; with the pulled 4B the final run took **0.8 s** (3.4 s
  on the cold call) while the remote turn took **62.6 s**. Both chose
  `deepseek/deepseek-v4-pro` under cost policy with the quality floor,
  `applied: "same-turn"`.
- Every OpenCode step now asserts a `turns.jsonl` record and prints the split.
  A stub-judge `judge-cost` turn measured route 19 ms (judge 8 ms) vs remote
  model 6.5 s and tools 45 ms.

The first run exposed four bugs that fake-based unit tests missed:

- The V2 `context` event has `{providerID, id}` but no limits, so the optimiser
  saw zero context, returned `overflow` on every turn, and cleared the pin.
  `Router.modelFor` now fills the catalog entry.
- Context and prompt hooks write the same pin asynchronously; a context write
  could erase a newly chosen model. Both writers now merge with the latest pin,
  and context refuses to overwrite a newer model.
- Pin policy counted a downward complexity change as a jump and could report a
  switch while staying on the same model. Only upward jumps force a switch;
  same-model selections keep the pin.
- A rejected `switchModel` was logged as applied. It is now `applied: "none"`
  with the error and the previous model in `lastApplied`.

## Release checklist

- `bun run check` green.
- `bun run test:e2e` green against the current OpenCode and Kilo versions.
- README install steps match the published package name.
- `npm pack --dry-run` includes `dist/core.wasm`, `src`, `bin`, `README.md`,
  `LICENSE`, `config.example.json`.
- Pack-install smoke test in OpenCode (same-turn switch) and Kilo (boundary).
- Update the spec/README if behaviour changed.
- `jj bookmark set main -r @ && jj git push -b main`; publish to npm manually.

## Kilo catalogue normalisation

Kilo's V1 `config.providers()` returns a different model shape from OpenCode V2:
capabilities use `toolcall` and boolean maps, `cost` is an object, and `variants`
is a keyed map. The shim normalises those into the host-neutral shape before
pool resolution (tools, input/output, cost array, variant array). Without this,
`pool.requireTools` correctly filtered every Kilo model, producing `no_pool`.
Verified with a packed install: pool of two, decision `applied: "boundary"`,
chosen model `deepseek/deepseek-flash`.

## Judge provisioning verification (2026-11-15)

Verified against the live oMLX 0.6.4 admin API without starting a large download:

- `POST /admin/api/login` with the main key from `~/.omlx/settings.json` returns
  the `omlx_admin_session` cookie.
- `GET /admin/api/hf/model-info?repo_id=mlx-community/Qwen3-4B-Instruct-2507-4bit`
  returns params 4.0B, ~2.1 GB of files, `license:apache-2.0`, `mlx` tag.
- `omlx-router judge pull` printed that summary and, after a declined prompt,
  made **no** download request. `judge status` and consent gating are covered by
  fake-server tests; the download path uses `/api/hf/download` and
  `/api/hf/tasks` and triggers oMLX model rediscovery on completion.

## Routing-quality eval (2026-11-16)

`bun run routing:eval -- --runs 3` compares the model chosen with the real 4B
verdict against the model the same cost scorer would choose with a ground-truth
verdict (the cheapest adequate model).

Initial run: **7/9 matched, 2 under-routes, 0 over-routes, -20% cost delta**.
The misses were a three-file refactor and a design-comparison turn; both were
under-provisioned because the raw verdict stayed at complexity 3/2.

After adding a `multiFile` signal and a minimum complexity of 3 for
planning/review:

```text
routing match 27/27 · under-routed 0 · over-routed 0 · mean cost delta 0%
```

The eval exits non-zero on an under-route, so it is a release gate. The
deterministic floor changes are also covered by Rust unit tests and the
`judge-underclassifies-multifile` prompt scenario, so CI catches them without
oMLX.

## 4B judge calibration (2026-11-15)

The original judge prompt made `Qwen3-4B-Instruct-2507-4bit` copy the schema's
`"complexity":1` example. After adding few-shot examples, an explicit "do not
copy" rule, and a deterministic floor from the envelope signals:

| Case | Task | Raw → effective complexity | Reasoning | Context | Warm latency |
|---|---|---|---|---|---|
| simple question | research | 1 → 2 | low | small | 0.9 s |
| small edit | edit | 2 → 3 | medium | small | 0.7 s |
| debug trace | debug | 4 → 4 | high | small | 0.7 s |
| planning | refactor | 3 → 4 | high | medium | 0.6 s |
| security review | review | 2 → 4 | high | small | 0.6 s |
| 90k context | refactor | 2 → 3 | medium | large | 0.6 s |

`bun tests/judge-calibration.mjs` reproduces this and compares explicit models
with `--model`. Warm calls are 0.6-0.9 s; the cold first call measured 2.8 s, so
the default timeout is 5 s. The 27B baseline was 7-23 s and failed the review
case with unparsable JSON; the 4B is the intended judge.

The deterministic `reconcile` step is important: the 4B still occasionally
under-classifies, and the envelope floor prevents a debug/review/planning turn
from being downgraded. Marker matching uses word boundaries so `Inspect` no
longer matches `spec`.

## Telemetry (2026-11-15)

The adapter subscribes to `session.execution.*` and `session.step.*` events and
writes one `turns.jsonl` record per turn. Decision records also carry
`timing.routeMs/judgeMs/coreMs/switchMs` and the effective `verdict`.

Fields in a turn record:

- `routeMs`, `judgeMs`, `coreMs`, `switchMs` — local routing cost
- `executionMs` — from execution start to succeeded/failed
- `modelMs` — sum of model-step durations
- `toolMs` — `executionMs - modelMs`
- `ttftMs` — first step's time to first token
- `turnMs` — prompt admission to execution end
- `steps`, `tokens`, `cost`, `model`, `usedModel`

`/router timing`, `omlx-router timing`, and the `timing` line in `/router
status` show which side dominates. Kilo currently records route/judge timing in
decisions but not the host turn record, because its V1 event stream needs a
separate SSE adapter.
