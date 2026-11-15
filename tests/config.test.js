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
