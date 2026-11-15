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
