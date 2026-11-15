import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { matchesGlob, readHostModelState, resolvePool } from "../src/pool.js"

function catalog() {
  return [
    {
      providerID: "deepseek",
      id: "deepseek-flash",
      name: "DeepSeek Flash",
      type: "chat",
      settings: { baseURL: "https://api.deepseek.com" },
      variants: [{ id: "high" }],
      cost: [{ input: 0.2, output: 0.8, cache: { read: 0.05, write: 0.2 } }],
      limit: { context: 262144, output: 131072 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      status: "active",
    },
    {
      providerID: "omlx",
      id: "local-4b",
      name: "Local 4B",
      type: "chat",
      settings: { baseURL: "http://127.0.0.1:1234/v1" },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      limit: { context: 32768, output: 8192 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      status: "active",
    },
    {
      providerID: "acme",
      id: "no-tools",
      name: "No Tools 8B",
      type: "chat",
      cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }],
      limit: { context: 128000, output: 8192 },
      capabilities: { tools: false, input: ["text"], output: ["text"] },
      status: "active",
    },
    {
      providerID: "acme",
      id: "old",
      name: "Old 70B",
      type: "chat",
      cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }],
      limit: { context: 128000, output: 8192 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      status: "deprecated",
    },
  ]
}

function config(overrides = {}) {
  return {
    pool: { source: "favorites", models: [], include: [], exclude: [], maxModels: 8, requireTools: true, minContext: 0 },
    quality: { overrides: { "deepseek/deepseek-flash": 0.8 } },
    latency: { overrides: {}, localProviders: [] },
    ...overrides,
  }
}

function envWithFavorites(favorites, variant = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-pool-"))
  const file = path.join(dir, "model.json")
  fs.writeFileSync(file, JSON.stringify({ favorite: favorites, variant }))
  return { OMLX_ROUTER_FAVORITES: file }
}

test("favorites resolve against the catalog with variant and local flag", () => {
  const env = envWithFavorites(
    [
      { providerID: "deepseek", modelID: "deepseek-flash" },
      { providerID: "omlx", modelID: "local-4b" },
    ],
    { "deepseek/deepseek-flash": "high" },
  )
  const { pool, warnings } = resolvePool({ models: catalog(), config: config(), env })
  expect(warnings).toEqual([])
  expect(pool.map((model) => model.modelID)).toEqual(["deepseek-flash", "local-4b"])
  const flash = pool.find((model) => model.modelID === "deepseek-flash")
  expect(flash.variant).toBe("high")
  expect(flash.local).toBe(false)
  expect(flash.qualityOverride).toBe(0.8)
  const local = pool.find((model) => model.modelID === "local-4b")
  expect(local.local).toBe(true)
})

test("empty favorites fall back to available models", () => {
  const env = envWithFavorites([])
  const { pool, warnings } = resolvePool({ models: catalog(), config: config(), env })
  expect(warnings[0]).toContain("favorites-empty")
  expect(pool.map((model) => model.modelID)).toContain("deepseek-flash")
  expect(pool.map((model) => model.modelID)).not.toContain("no-tools")
  expect(pool.map((model) => model.modelID)).not.toContain("old")
})

test("explicit list reports missing entries and respects exclusions", () => {
  const env = envWithFavorites([])
  const { pool, warnings } = resolvePool({
    models: catalog(),
    config: config({
      pool: {
        source: "list",
        models: ["deepseek/deepseek-flash#high", "acme/missing"],
        include: [],
        exclude: ["omlx/*"],
        maxModels: 8,
        requireTools: true,
        minContext: 0,
      },
    }),
    env,
  })
  expect(warnings).toContain("missing: acme/missing")
  expect(pool.length).toBe(1)
  expect(pool[0].variant).toBe("high")
})

test("minContext filters and include can force-add", () => {
  const env = envWithFavorites([{ providerID: "omlx", modelID: "local-4b" }])
  const { pool } = resolvePool({
    models: catalog(),
    config: config({
      pool: {
        source: "favorites",
        models: [],
        include: ["deepseek/*"],
        exclude: [],
        maxModels: 8,
        requireTools: true,
        minContext: 100000,
      },
    }),
    env,
  })
  expect(pool.map((model) => model.modelID)).toEqual(["deepseek-flash"])
})

test("host model state tolerates a missing file", () => {
  const state = readHostModelState("opencode", { OMLX_ROUTER_FAVORITES: "/definitely/missing" })
  expect(state).toEqual({ favorite: [], variant: {} })
})

test("glob matching is anchored and case-insensitive", () => {
  expect(matchesGlob("deepseek/*", "deepseek/deepseek-flash")).toBe(true)
  expect(matchesGlob("*/flash", "deepseek/deepseek-flash")).toBe(false)
  expect(matchesGlob("*flash", "deepseek/deepseek-flash")).toBe(true)
  expect(matchesGlob("deepseek", "deepseek/deepseek-flash")).toBe(false)
  expect(matchesGlob("DEEPSEEK/*", "deepseek/deepseek-flash")).toBe(true)
})
