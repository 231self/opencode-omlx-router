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

## Release checklist

- `bun run check` green.
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
