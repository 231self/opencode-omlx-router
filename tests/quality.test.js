import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { resolvePool } from "../src/pool.js"
import {
  buildScores,
  loadQualityScores,
  modelKeys,
  normalizeModelName,
  qualityCacheAgeMs,
  qualityCachePath,
  qualityForModel,
  qualityIsStale,
  readQualityCache,
  refreshQuality,
  writeQualityCache,
} from "../src/quality.js"

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-quality-"))
  return {
    dir,
    env: {
      OMLX_ROUTER_STATE: path.join(dir, "state"),
      OMLX_ROUTER_FAVORITES: path.join(dir, "favorites.json"),
    },
  }
}

function config(overrides = {}) {
  return {
    quality: {
      source: "lmarena",
      refreshHours: 24,
      timeoutMs: 1000,
      lmarena: {
        dataset: "lmarena-ai/leaderboard-dataset",
        config: "webdev",
        split: "latest",
      },
      overrides: {},
      ...overrides,
    },
  }
}

function row(name, rank, category = "overall") {
  return { model_name: name, rank, category, rating: 1400, organization: "acme" }
}

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

test("model names normalise to a stable key", () => {
  expect(normalizeModelName("Claude Fable 5.2 (xHigh)")).toBe("claudefable52")
  expect(normalizeModelName("anthropic/claude-fable-5-2")).toBe("claudefable52")
  expect(modelKeys({ providerID: "openai", id: "gpt-6-astra", name: "GPT-6 Astra" })).toContain(
    "gpt6astra",
  )
})

test("rank percentile maps onto the router quality scale", () => {
  const cache = buildScores(
    [row("Top", 1), row("Two", 2), row("Middle", 3), row("Four", 4), row("Bottom", 5)],
    { config: "webdev", count: 5 },
  )
  expect(cache.scores.top.quality).toBe(0.97)
  expect(cache.scores.bottom.quality).toBe(0.35)
  expect(cache.scores.middle.quality).toBe(0.66)
  expect(cache.count).toBe(5)
})

test("the best variant wins and non-overall categories are ignored", () => {
  const cache = buildScores(
    [
      row("Claude Fable 5.2 (High)", 8),
      row("Claude Fable 5.2 (xHigh)", 2),
      row("Claude Fable 5.2 (Max)", 1, "coding"),
      row("Other", 1),
      row("Third", 3),
      row("Fourth", 4),
      row("Fifth", 5),
      row("Sixth", 6),
      row("Seventh", 7),
      row("Ninth", 9),
      row("Tenth", 10),
    ],
    { count: 10 },
  )
  expect(cache.scores.claudefable52.rank).toBe(2)
  expect(cache.scores.claudefable52.quality).toBeGreaterThan(0.8)
})

test("matching tries the label, id, and display name", () => {
  const scores = { deepseekv4pro: { quality: 0.8, rank: 3, model: "DeepSeek V4 Pro" } }
  expect(qualityForModel(scores, { providerID: "deepseek", id: "deepseek-v4-pro" })?.quality).toBe(0.8)
  expect(qualityForModel(scores, { providerID: "x", id: "other", name: "DeepSeek V4 Pro" })?.quality).toBe(0.8)
  expect(qualityForModel(scores, { providerID: "x", id: "other" })).toBeNull()
})

test("refresh pages through the public rows endpoint and caches scores", async () => {
  const { env } = tempEnv()
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const offset = Number(new URL(url).searchParams.get("offset"))
    if (offset === 0) {
      return json({
        num_rows_total: 3,
        rows: [
          { row: row("Claude Fable 5.2 (xHigh)", 1) },
          { row: row("GPT-6 Astra (Max)", 2) },
        ],
      })
    }
    return json({ num_rows_total: 3, rows: [{ row: row("Gemini 4 Carbon (High)", 3) }] })
  }

  const cache = await refreshQuality({ config: config(), env, fetchImpl })
  expect(calls.length).toBe(2)
  expect(cache.count).toBe(3)
  expect(cache.scores.claudefable52.quality).toBe(0.97)
  expect(readQualityCache(env).scores.gpt6astra.quality).toBe(0.66)
  expect(qualityCachePath(env)).toContain("quality.json")
  expect(qualityCacheAgeMs(cache)).toBeGreaterThanOrEqual(0)
  expect(loadQualityScores({ config: config(), env })).toEqual(cache.scores)
  expect(qualityIsStale(config(), cache)).toBe(false)
})

test("a failed refresh keeps the existing cache", async () => {
  const { env } = tempEnv()
  writeQualityCache(
    { source: "lmarena", config: "webdev", fetchedAt: Date.now(), count: 1, scores: { a: { quality: 0.5, rank: 1 } } },
    env,
  )
  const fetchImpl = async () => new Response("nope", { status: 503 })
  await expect(refreshQuality({ config: config(), env, fetchImpl })).rejects.toThrow("HTTP 503")
  expect(readQualityCache(env).scores.a.quality).toBe(0.5)
})

test("manual quality disables fetching and scoring", async () => {
  const { env } = tempEnv()
  const manual = config({ source: "manual" })
  expect(loadQualityScores({ config: manual, env })).toBeNull()
  await expect(refreshQuality({ config: manual, env })).rejects.toThrow("manual")
})

test("pool resolution uses lmarena scores unless an override exists", () => {
  const { env } = tempEnv()
  const models = [
    {
      providerID: "deepseek",
      id: "deepseek-flash",
      name: "DeepSeek Flash",
      type: "chat",
      cost: [{ input: 0.2, output: 0.8, cache: { read: 0.05, write: 0.2 } }],
      limit: { context: 64000, output: 8000 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      status: "active",
    },
  ]
  const settings = {
    pool: { source: "list", models: ["deepseek/deepseek-flash"], requireTools: true, minContext: 0, localCostZero: true },
    quality: { source: "lmarena", overrides: {} },
  }
  const scored = resolvePool({
    models,
    providers: [],
    config: settings,
    env,
    qualityScores: { deepseekflash: { quality: 0.88, rank: 2, model: "DeepSeek Flash" } },
  })
  expect(scored.pool[0].qualityOverride).toBe(0.88)
  expect(scored.pool[0].qualitySource).toBe("lmarena")

  const overridden = resolvePool({
    models,
    providers: [],
    config: { ...settings, quality: { source: "lmarena", overrides: { "deepseek/deepseek-flash": 0.5 } } },
    env,
    qualityScores: { deepseekflash: { quality: 0.88, rank: 2 } },
  })
  expect(overridden.pool[0].qualityOverride).toBe(0.5)
  expect(overridden.pool[0].qualitySource).toBe("override")
})
