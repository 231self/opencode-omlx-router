import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  DEFAULT_CONFIG,
  configPath,
  getConfigValue,
  mergeConfig,
  readConfig,
  resolvePolicyWeights,
  saveConfig,
  setConfigValue,
} from "../src/config.js"

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-config-"))
  return {
    dir,
    env: {
      OMLX_ROUTER_CONFIG: path.join(dir, "config.json"),
      OMLX_ROUTER_STATE: path.join(dir, "state"),
    },
  }
}

test("missing config seeds defaults and writes the file", () => {
  const { env } = tempEnv()
  const result = readConfig({ env })
  expect(result.existed).toBe(false)
  expect(result.seeded).toBe(true)
  expect(result.config.policy).toBe(DEFAULT_CONFIG.policy)
  expect(fs.existsSync(configPath(env))).toBe(true)
})

test("plugin options seed the first config only", () => {
  const { env } = tempEnv()
  const first = readConfig({ env, seed: { policy: "quality", pool: { maxModels: 4 } } })
  expect(first.config.policy).toBe("quality")
  expect(first.config.pool.maxModels).toBe(4)
  expect(first.config.pool.source).toBe(DEFAULT_CONFIG.pool.source)

  const second = readConfig({ env, seed: { policy: "latency" } })
  expect(second.existed).toBe(true)
  expect(second.config.policy).toBe("quality")
})

test("invalid JSON reports an error and keeps defaults without overwriting", () => {
  const { env } = tempEnv()
  const file = configPath(env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, "{ nope")
  const result = readConfig({ env })
  expect(result.error).toContain("invalid config")
  expect(result.config.policy).toBe(DEFAULT_CONFIG.policy)
  expect(fs.readFileSync(file, "utf8")).toBe("{ nope")
})

test("mergeConfig is recursive and replaces arrays", () => {
  const merged = mergeConfig(
    { pool: { source: "favorites", models: ["a"] }, policy: "cost" },
    { pool: { models: ["b"] } },
  )
  expect(merged.pool.source).toBe("favorites")
  expect(merged.pool.models).toEqual(["b"])
  expect(merged.policy).toBe("cost")
})

test("getConfigValue and setConfigValue walk dot paths", () => {
  const config = setConfigValue(DEFAULT_CONFIG, "subagents.agents.explore.qualityFloor", 0.6)
  expect(getConfigValue(config, "subagents.agents.explore.qualityFloor")).toBe(0.6)
  expect(getConfigValue(config, "missing.path")).toBeUndefined()
})

test("saveConfig writes merged defaults", () => {
  const { env } = tempEnv()
  const saved = saveConfig({ enabled: false }, { env })
  expect(saved.enabled).toBe(false)
  expect(saved.pool.source).toBe(DEFAULT_CONFIG.pool.source)
  const reread = readConfig({ env })
  expect(reread.config.enabled).toBe(false)
})

test("the default judge timeout covers a cold 4B judge", () => {
  expect(DEFAULT_CONFIG.judge.timeoutMs).toBe(5000)
})

test("local providers are zero-cost by default", () => {
  expect(DEFAULT_CONFIG.pool.localCostZero).toBe(true)
})

test("quality scores use the keyless LMArena source by default", () => {
  expect(DEFAULT_CONFIG.quality.source).toBe("lmarena")
  expect(DEFAULT_CONFIG.quality.refreshHours).toBe(24)
})

test("custom policy weights layer over presets and per class", () => {
  const config = {
    policy: "cost",
    policyWeights: { cost: 0.6, quality: 0.35, latency: 0.05 },
    policyByClass: {
      planning: { cost: 0.1, quality: 0.8, latency: 0.1 },
      trivial: { cost: 0.85, quality: 0.1 },
    },
  }
  expect(resolvePolicyWeights(config)).toEqual({ cost: 0.6, quality: 0.35, latency: 0.05 })
  expect(resolvePolicyWeights(config, "planning")).toEqual({ cost: 0.1, quality: 0.8, latency: 0.1 })
  expect(resolvePolicyWeights(config, "trivial")).toEqual({ cost: 0.85, quality: 0.1, latency: 0.05 })
})

test("zero policy weights fall back to the preset", () => {
  const config = { policy: "cost", policyWeights: { cost: 0, quality: 0, latency: 0 } }
  expect(resolvePolicyWeights(config)).toEqual({ cost: 0.6, quality: 0.3, latency: 0.1 })
})
