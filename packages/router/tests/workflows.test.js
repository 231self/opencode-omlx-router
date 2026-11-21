import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..")
const WORKFLOWS = ["ci.yml", "security.yml", "release.yml"]

// The monorepo move (core/ -> packages/*/core, dist/ -> packages/*/dist) left
// the workflows pointing at paths that no longer exist, and the workspace
// links need an install step before bun test. Both failed only in CI, so lock
// the invariants down where the suite can see them.
test("workflows reference only existing crate and artifact paths", () => {
  for (const name of WORKFLOWS) {
    const text = fs.readFileSync(path.join(ROOT, ".github/workflows", name), "utf8")
    expect(text).not.toContain("--manifest-path core/")
    expect(text).not.toContain("working-directory: core\n")
    expect(text).not.toContain("< dist/core.wasm")

    // Literal paths must exist; shell-variable paths ($crate loops) are
    // covered by the run step's own failure behaviour.
    for (const match of text.matchAll(/--manifest-path (\S+)/g)) {
      const target = match[1].replaceAll('"', "")
      if (target.includes("$")) continue
      expect(fs.existsSync(path.join(ROOT, target))).toBe(true)
    }
    for (const match of text.matchAll(/working-directory: (\S+)/g)) {
      const target = match[1].replaceAll('"', "")
      if (target.includes("$")) continue
      expect(fs.existsSync(path.join(ROOT, target))).toBe(true)
    }
  }
})

test("workflows that run tests install the workspace first", () => {
  for (const name of WORKFLOWS) {
    const text = fs.readFileSync(path.join(ROOT, ".github/workflows", name), "utf8")
    if (text.includes("bun test") || text.includes("bun run check")) {
      expect(text).toContain("bun install")
    }
  }
})
