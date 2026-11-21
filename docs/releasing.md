# Building and releasing

## Requirements

| Tool | Version | Why |
|---|---|---|
| Bun | ≥ 1.4 | Tests and scripts |
| Rust | stable, 1.98 tested | Core |
| `wasm32-unknown-unknown` target | — | Core build |
| binaryen (`wasm-opt`) | optional | Size optimisation; CI installs it |
| npm trusted publisher | one-time | OIDC publish from CI: no token, no 2FA prompt |
| `gh` | authenticated | Release/tag |

```sh
rustup target add wasm32-unknown-unknown
```

## Build

```sh
bun install                 # no runtime dependencies; creates the lockfile
bun run build:wasm          # cargo build --release --target wasm32-unknown-unknown
bun test                    # adapter + wasm bridge (rebuilds wasm first)
bun run test:rust           # cargo test
bun run check               # fmt, clippy -D warnings, both suites, size gate
```

Artifacts:

- `dist/core.wasm` — the only compiled file, committed for git installs and
  included in npm packs by `prepack`.
- `src/` — plain ESM host adapters, no build step.
- `bin/omlx-router.mjs` — CLI (`opencode-model-router`, alias `omlx-router`).

`npm pack --dry-run` must list `dist/core.wasm`, `src/`, `bin/`, `README.md`,
`CHANGELOG.md`, `LICENSE`, and `config.example.json`.

## Version and changelog

1. Bump `version` in `package.json` (and `Cargo.toml` for the core).
2. Move the `CHANGELOG.md` section from `unreleased` to the release version.
3. Update README install/usage if behaviour changed.
4. `bun run check`.
5. `bun run test:e2e` (prompt tests against OpenCode and Kilo) and, with oMLX
   running, `bun run judge:calibrate` (real judge verdicts/latency),
   `bun run routing:eval -- --runs 3` (routing vs an oracle; must have zero
   under-routes), and `bun run test:e2e:live` (real judge routing).
6. `jj describe -m "release: v0.2.7"`, `jj new`.

## Publish to npm

Publishing happens from CI: `.github/workflows/release.yml` runs when a GitHub
Release is published, re-validates everything (`bun run check`), checks the tag
against `package.json` and the changelog, and runs `npm publish` over npm
trusted publishing (OIDC). There is no `NPM_TOKEN`, no access token, and no
2FA prompt anywhere in the flow; the publish also carries a signed provenance
attestation.

One-time setup on [npmjs.com](https://www.npmjs.com/package/@231self/opencode-router):
package → Settings → Trusted Publisher → GitHub Actions → owner `231self`,
repository `opencode-router`, workflow `release.yml` — spelling and case must
match exactly. The repository must stay public (provenance requirement).

Fallback if trusted publishing is unavailable: add an `NPM_TOKEN` secret (an
automation token) and set `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` on the
publish step. This reintroduces a long-lived credential; prefer OIDC.

Verify after a release:

```sh
npm view @231self/opencode-router version
```

After the first publish under the new name, deprecate the old package:

```sh
npm deprecate @231self/opencode-omlx-router \
  "Renamed to @231self/opencode-router"
```

The CLI exposes `opencode-model-router` plus the `omlx-router` alias.

## Tag and GitHub release

This is the release: publishing the GitHub Release triggers the npm publish.

```sh
VERSION=$(node -p 'require("./package.json").version')

jj bookmark set main -r @-
jj git push -b main
jj tag set "v$VERSION" -r main
jj git push --tag "v$VERSION"

sed -n "/^## $VERSION /,/^## /p" CHANGELOG.md | sed '1d;$d' > /tmp/notes.md
gh release create "v$VERSION" --title "v$VERSION" --notes-file /tmp/notes.md
```

`ci.yml` should be green on the tagged commit first (rustfmt, clippy, Rust
tests, wasm build, Bun tests, the 600 KiB size gate, the security gate), and
the `release` workflow re-runs all of it before publishing: a red check stops
the release. Prereleases never publish (`release.yml` skips them).

## Verify the published artifact

```sh
mkdir -p /tmp/omlx-verify && cd /tmp/omlx-verify
npm pack @231self/opencode-router
tar -tzf 231self-opencode-router-0.2.7.tgz | head
```

Then install it as a consumer (below) in a scratch project and confirm a
decision is logged in `~/.local/state/omlx-router/opencode/decisions.jsonl`.
The prompt harness can drive the installed package directly:

```sh
npm install ./231self-opencode-router-0.2.7.tgz
bun tests/e2e/run.mjs --only judge-cost --package "$PWD/node_modules/@231self/opencode-router"
bun tests/e2e/run.mjs --only kilo-boundary --package "$PWD/node_modules/@231self/opencode-router"
```

## Consumer install (after publish)

### OpenCode V2

```sh
opencode plugin add @231self/opencode-router
```

or in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@231self/opencode-router"]
}
```

Then in the TUI: `/router` for status, `/router judge` to test the judge,
`/router policy` to choose a policy.

### Kilo

```sh
kilo plugin @231self/opencode-router
```

or in `~/.config/kilo/kilo.jsonc` / project `kilo.jsonc`:

```jsonc
{
  "$schema": "https://app.kilo.ai/config.json",
  "plugin": ["@231self/opencode-router"]
}
```

Kilo applies a decision at the next request boundary; use `opencode-model-router status`
and `opencode-model-router history` for visibility.

### From a git checkout (works before npm publish)

```sh
git clone https://github.com/231self/opencode-router
cd opencode-router
bun install
bun run build:wasm
```

OpenCode config:

```jsonc
{ "plugins": ["/absolute/path/to/opencode-router"] }
```

Kilo config:

```jsonc
{ "plugin": ["/absolute/path/to/opencode-router/src/index.js"] }
```

## Post-release

- `gh repo edit 231self/opencode-omlx-router --add-topic ...`
- Watch `gh run list` and `npm view @231self/opencode-router`.
- If a bad release ships within 72 h: `npm unpublish @231self/opencode-router@x.y.z`
  (avoid if possible; prefer `npm deprecate` and a patch).
- Never reuse a published version.

## Rollback/disable for users

- Disable the plugin: `opencode plugin remove @231self/opencode-router` or set
  `"enabled": false` in `~/.config/omlx-router/config.json`.
- The plugin never modifies host files; removing it leaves only config/state
  under `~/.config/omlx-router` and `~/.local/state/omlx-router`.
