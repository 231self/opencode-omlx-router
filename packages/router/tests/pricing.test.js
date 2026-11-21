import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  PRICING_SOURCES,
  buildPricesFromLiteLLM,
  buildPricesFromModelsDev,
  loadPricing,
  priceForModel,
  pricingCachePath,
  pricingIsStale,
  pricingOrder,
  readPricingCache,
  refreshPricing,
  refreshPricingIfStale,
  writePricingCache,
} from "../src/pricing.js"

function environment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-pricing-"))
  return { OMLX_ROUTER_PRICING_CACHE: path.join(dir, "pricing.json") }
}

function config(overrides = {}) {
  return {
    pricing: { source: "modelsdev", sources: ["modelsdev", "litellm"], refreshHours: 24, ...overrides },
  }
}

// What models.dev really returns: flat, per million, cache_read/cache_write.
const MODELSDEV_DOC = {
  anthropic: {
    models: {
      "claude-opus-5-5": { cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } },
    },
  },
  openai: { models: { "gpt-6.1-sol": { cost: { input: 2, output: 10, cache_read: 0.1 } } } },
}

// LiteLLM prices are per token and keyed by model name alone.
const LITELLM_DOC = {
  "claude-opus-5-5": {
    input_cost_per_token: 4e-6,
    output_cost_per_token: 2e-5,
    cache_read_input_token_cost: 2e-7,
    litellm_provider: "anthropic",
  },
  "some-free-model": {
    input_cost_per_token: 0,
    output_cost_per_token: 0,
    litellm_provider: "openai",
  },
}

function fetchServing(map) {
  return async (url) => {
    const body = map[url]
    if (body === undefined) return { ok: false, status: 404, json: async () => null }
    return { ok: true, status: 200, json: async () => body }
  }
}

test("models.dev prices are indexed by provider and by model id", () => {
  const { prices, byId, count } = buildPricesFromModelsDev(MODELSDEV_DOC)
  expect(count).toBe(2)
  expect(prices["anthropic/claude-opus-5-5"][0]).toMatchObject({ input: 4, output: 20 })
  expect(byId.claudeopus55[0].cache.read).toBe(0.2)
  expect(byId.claudeopus55[0].cache.write).toBe(5)
})

test("litellm per-token costs are converted to per million", () => {
  const { prices, byId, count } = buildPricesFromLiteLLM(LITELLM_DOC)
  expect(count).toBe(2)
  expect(prices["anthropic/claude-opus-5-5"][0]).toEqual({
    input: 4,
    output: 20,
    cache: { read: 0.2, write: undefined },
  })
  expect(byId.somefreemodel[0]).toMatchObject({ input: 0, output: 0 })
})

test("priceForModel finds a model by provider and by id", () => {
  const cache = { prices: buildPricesFromModelsDev(MODELSDEV_DOC).prices, byId: buildPricesFromModelsDev(MODELSDEV_DOC).byId }
  expect(priceForModel(cache, { providerID: "anthropic", id: "claude-opus-5-5" })[0].input).toBe(4)
  // A host that names the provider differently still matches on the id.
  expect(priceForModel(cache, { providerID: "proxy", id: "claude-opus-5-5" })[0].input).toBe(4)
  expect(priceForModel(cache, { providerID: "231code", id: "FBYvDFfIx1R2ALanomXiZ" })).toBeNull()
  expect(priceForModel(null, { providerID: "anthropic", id: "claude-opus-5-5" })).toBeNull()
})

test("refresh merges every enabled source, first source wins", async () => {
  const env = environment()
  const fetchImpl = fetchServing({
    [PRICING_SOURCES.modelsdev.url]: MODELSDEV_DOC,
    [PRICING_SOURCES.litellm.url]: LITELLM_DOC,
  })
  const cache = await refreshPricing({ config: config(), env, fetchImpl })
  expect(cache.source).toBe("modelsdev+litellm")
  expect(cache.count).toBe(3)
  expect(cache.prices["anthropic/claude-opus-5-5"][0].cache.write).toBe(5)
  expect(cache.prices["openai/some-free-model"][0].input).toBe(0)
  expect(Object.keys(cache.sources)).toEqual(["modelsdev", "litellm"])
  expect(readPricingCache(env).count).toBe(3)
  expect(loadPricing({ config: config(), env })).not.toBeNull()
})

test("a failing source does not discard the ones that worked", async () => {
  const env = environment()
  const fetchImpl = fetchServing({ [PRICING_SOURCES.litellm.url]: LITELLM_DOC })
  const cache = await refreshPricing({ config: config(), env, fetchImpl })
  expect(cache.source).toBe("litellm")
  expect(cache.prices["anthropic/claude-opus-5-5"][0].input).toBe(4)
  expect(cache.errors.length).toBe(1)
})

test("refresh fails only when every source fails", async () => {
  const env = environment()
  const fetchImpl = fetchServing({})
  await expect(refreshPricing({ config: config(), env, fetchImpl })).rejects.toThrow(
    /pricing refresh failed/,
  )
})

test("pricing source and order follow the config", () => {
  expect(pricingOrder(config())).toEqual(["modelsdev", "litellm"])
  expect(pricingOrder(config({ sources: ["litellm"] }))).toEqual(["litellm"])
  expect(pricingOrder(config({ source: "off" }))).toEqual([])
  expect(loadPricing({ config: config({ source: "off" }), env: environment() })).toBeNull()
})

test("the table refreshes only when it is stale", async () => {
  const env = environment()
  const fetchImpl = fetchServing({ [PRICING_SOURCES.modelsdev.url]: MODELSDEV_DOC })
  const fresh = await refreshPricingIfStale({ config: config(), env, fetchImpl })
  expect(fresh.count).toBe(2)

  // Fresh enough: no network call.
  let calls = 0
  await refreshPricingIfStale({
    config: config(),
    env,
    fetchImpl: async (url) => {
      calls += 1
      return fetchImpl(url)
    },
  })
  expect(calls).toBe(0)

  const stale = { ...readPricingCache(env), fetchedAt: Date.now() - 25 * 3_600_000 }
  expect(pricingIsStale(config(), stale)).toBe(true)
  writePricingCache(stale, env)
  const refreshed = await refreshPricingIfStale({ config: config(), env, fetchImpl })
  expect(refreshed.fetchedAt).toBeGreaterThan(stale.fetchedAt)
  expect(pricingCachePath(env).endsWith("pricing.json")).toBe(true)
})

test("an uncached table is stale and a disabled source refreshes nothing", async () => {
  const env = environment()
  expect(pricingIsStale(config(), null)).toBe(true)
  expect(await refreshPricingIfStale({ config: config({ source: "off" }), env })).toBeNull()
})
