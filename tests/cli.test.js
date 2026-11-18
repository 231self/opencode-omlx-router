import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { writePricingCache } from "../src/pricing.js"
import { ABI_VERSION, VERSION } from "../src/version.js"

const bin = path.resolve(import.meta.dir, "../bin/omlx-router.mjs")

function run(...args) {
  return runWithEnv(process.env, ...args)
}

function runWithEnv(env, ...args) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env })
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

test("omlx-router version prints the bare version", () => {
  const result = run("version")
  expect(result.code).toBe(0)
  expect(result.stdout).toBe(VERSION)
})

test("omlx-router version --json reports name, version, and ABI", () => {
  const result = run("version", "--json")
  expect(result.code).toBe(0)
  const info = JSON.parse(result.stdout)
  expect(info.name).toBe("opencode-router")
  expect(info.version).toBe(VERSION)
  expect(info.abi).toBe(ABI_VERSION)
})

test("pricing reports an empty cache and looks models up", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-cli-pricing-"))
  const env = {
    OMLX_ROUTER_PRICING_CACHE: path.join(dir, "pricing.json"),
    OMLX_ROUTER_CONFIG: path.join(dir, "config.json"),
  }
  const empty = runWithEnv(env, "pricing")
  expect(empty.code).toBe(0)
  expect(empty.stdout).toContain("none; run: opencode-model-router pricing refresh")

  writePricingCache(
    {
      source: "modelsdev",
      fetchedAt: Date.now(),
      count: 1,
      prices: { "anthropic/claude-opus-5-5": [{ input: 4, output: 20, cache: { read: 0.2, write: 5 } }] },
      byId: {},
      sources: { modelsdev: { url: "https://models.dev/api.json", fetchedAt: Date.now(), count: 1 } },
    },
    env,
  )
  const known = runWithEnv(env, "pricing", "anthropic/claude-opus-5-5")
  expect(known.code).toBe(0)
  expect(known.stdout).toContain("in $4 · out $20 · cache read $0.2 /M")

  const unknown = runWithEnv(env, "pricing", "acme/nope")
  expect(unknown.code).toBe(1)
  expect(unknown.stdout).toContain("unknown (no pricing data)")
})

test("unknown parameters print usage instead of being ignored", () => {
  const pricing = run("pricing", "resfresh")
  expect(pricing.code).toBe(1)
  expect(pricing.stderr).toContain('unknown parameter "resfresh"')
  expect(pricing.stderr).toContain("usage: opencode-model-router pricing [refresh|provider/model]")

  const pins = run("pins", "wipe")
  expect(pins.code).toBe(1)
  expect(pins.stderr).toContain("usage: opencode-model-router pins [clear]")

  const quality = run("quality", "rebuild")
  expect(quality.code).toBe(1)
  expect(quality.stderr).toContain("usage: opencode-model-router quality [status|refresh]")

  const history = run("history", "many")
  expect(history.code).toBe(1)
  expect(history.stderr).toContain("usage: opencode-model-router history [n]")

  const judge = run("judge", "fetch")
  expect(judge.code).toBe(1)
  expect(judge.stderr).toContain("usage: opencode-model-router judge [pull|status|cancel|probe]")
})
