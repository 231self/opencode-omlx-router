# Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Nothing routes | `/router status`; `opencode-model-router status` | Enable routing (`/router on`), check pool is non-empty and `judge`/core errors |
| Pool is empty | `/router pool` | Favorites may all be filtered out (tools, context); add `pool.include` or switch to `source: "available"` |
| Every turn uses the same model | `/router explain` | A forced pin (user `/model` or agent model) is active; `/router auto` |
| Judge timeouts | `/router judge` | Use a ~4B judge; raise `judge.timeoutMs`; confirm oMLX is reachable at `judge.baseURL` |
| Wrong model chosen | `/router explain` | Adjust `quality.overrides`, policy, or pool; the heuristic uses price and parameter size |
| Model switching is slow/ignored in Kilo | decision log `applied: "boundary"` | Expected: Kilo's V1 API applies the switch at the next turn |
| Context overflow | decision log, `lastOptimiser.overflow` | The pin is cleared and host compaction runs; raise the pool context floor or lower `reserveOutputTokens` |
| Config edits do nothing | `~/.config/omlx-router/config.json` | The file wins after first run; plugin options only seed it |
| `@231self/opencode-router` loads but no decisions | `bun run build:wasm` | The package must contain `dist/core.wasm`; rebuilding from source requires cargo |
| Tool failures never escalate | tool hook registration | V2 supports `execute.after`; Kilo's V1 hook exposes errors only when the host reports them |
| TUI `/router` missing | OpenCode TUI, not headless | Use `opencode-model-router` CLI for `opencode run`, Desktop, or Kilo |
| Judge download says "admin login failed" | Missing/wrong main key | Set `judge.provision.adminApiKey`/`OMLX_ADMIN_API_KEY`; sub-keys cannot download |
| Download refuses the repo | Not MLX-shaped | Use an `mlx-community/*` repo or set `judge.provision.allowNonMlx` |
| Download completes but no judge | oMLX has not rediscovered | Reload models in the oMLX app, then `/router judge` |
| Download is cancelled/stalled | Network or HF gating | Retry; set `judge.provision.hfToken` for gated repos |

## Logs and evidence

- `~/.local/state/omlx-router/<host>/decisions.jsonl` — one JSON object per turn.
- `~/.local/state/omlx-router/<host>/pins/<hash>.json` — per-session pin, last
  applied model, last context token count, optimiser stats.
- Adapter debug: set `"debug": true` in config (never logs prompt text).
- OpenCode server logs: `~/.local/share/opencode/log/opencode.log`.

## Reset

```sh
rm -rf ~/.local/state/omlx-router        # pins and history
rm ~/.config/omlx-router/config.json    # settings (recreated from defaults)
```

## Reporting

Include the router version, host and version, `opencode-model-router doctor` output,
`/router explain` for a failing turn, and whether the judge is a local small
model. Redact model keys and any private prompts before sharing.
