import fs from "node:fs"
import path from "node:path"

import { normaliseCost } from "@231self/opencode-shared/cost.js"
import { normalizeModelName } from "./quality.js"
import { stateRoot, writeJsonAtomic } from "@231self/opencode-shared/state.js"

/**
 * Public price tables. None of these need an access token:
 * - models.dev — the catalogue OpenCode itself reads
 * - LiteLLM — per-token costs keyed by model name, with a provider hint
 */
export const PRICING_SOURCES = {
  modelsdev: { url: "https://models.dev/api.json" },
  litellm: {
    url: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  },
}
const DEFAULT_ORDER = ["modelsdev", "litellm"]

export function pricingCachePath(env = process.env) {
  return env.OMLX_ROUTER_PRICING_CACHE || path.join(stateRoot(env), "pricing.json")
}

export function pricingSource(config) {
  const source = config?.pricing?.source ?? "modelsdev"
  return ["modelsdev", "off"].includes(source) ? source : "modelsdev"
}

export function pricingOrder(config) {
  if (pricingSource(config) === "off") return []
  const configured = config?.pricing?.sources
  const list = Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_ORDER
  return [...new Set(list.filter((name) => name in PRICING_SOURCES))]
}

function record(prices, byId, key, id, tiers) {
  if (tiers.length === 0) return false
  if (!prices[key]) prices[key] = tiers
  if (id && !byId[id]) byId[id] = tiers
  return true
}

/** models.dev: `{ anthropic: { models: { "claude-opus-5-5": { cost } } } }`. */
export function buildPricesFromModelsDev(api) {
  const prices = {}
  const byId = {}
  let count = 0
  for (const [providerID, provider] of Object.entries(api ?? {})) {
    if (!provider || typeof provider !== "object") continue
    for (const [modelID, model] of Object.entries(provider.models ?? {})) {
      const tiers = normaliseCost(model?.cost)
      if (record(prices, byId, `${providerID}/${modelID}`, normalizeModelName(modelID), tiers)) {
        count += 1
      }
    }
  }
  return { prices, byId, count }
}

/**
 * LiteLLM: `{ "gpt-4o": { input_cost_per_token, output_cost_per_token,
 * cache_read_input_token_cost, litellm_provider } }`. Costs are per token;
 * the router prices per million.
 */
export function buildPricesFromLiteLLM(api) {
  const prices = {}
  const byId = {}
  let count = 0
  // Prices arrive per token; the router prices per million. Round the scaling
  // so 2e-7 does not display as 0.19999999999999998.
  const perMillion = (value) => Math.round(Number(value) * 1_000_000 * 1e6) / 1e6
  for (const [modelID, entry] of Object.entries(api ?? {})) {
    if (!entry || typeof entry !== "object") continue
    const input = Number(entry.input_cost_per_token)
    const output = Number(entry.output_cost_per_token)
    if (!Number.isFinite(input) && !Number.isFinite(output)) continue
    const tiers = normaliseCost({
      input: Number.isFinite(input) ? perMillion(input) : undefined,
      output: Number.isFinite(output) ? perMillion(output) : undefined,
      cache_read: Number.isFinite(Number(entry.cache_read_input_token_cost))
        ? perMillion(entry.cache_read_input_token_cost)
        : undefined,
      cache_write: Number.isFinite(Number(entry.cache_creation_input_token_cost))
        ? perMillion(entry.cache_creation_input_token_cost)
        : undefined,
    })
    if (tiers.length === 0) continue
    const providerID = typeof entry.litellm_provider === "string" ? entry.litellm_provider : ""
    const id = normalizeModelName(modelID)
    if (providerID) {
      const key = `${providerID}/${modelID}`
      if (!prices[key]) prices[key] = tiers
    }
    if (id && !byId[id]) byId[id] = tiers
    count += 1
  }
  return { prices, byId, count }
}

const BUILDERS = {
  modelsdev: buildPricesFromModelsDev,
  litellm: buildPricesFromLiteLLM,
}

export function readPricingCache(env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(pricingCachePath(env), "utf8"))
    if (!raw || typeof raw !== "object" || !raw.prices) return null
    return raw
  } catch {
    return null
  }
}

export function writePricingCache(cache, env = process.env) {
  writeJsonAtomic(pricingCachePath(env), cache)
  return cache
}

async function fetchSource(name, config, fetchImpl) {
  const settings = config?.pricing ?? {}
  const url = settings.url && name === pricingOrder(config)[0] ? settings.url : PRICING_SOURCES[name].url
  const timeoutMs = Math.max(1000, Number(settings.timeoutMs) || 20_000)
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  const body = await response.json().catch(() => null)
  if (!body || typeof body !== "object") throw new Error(`${url} returned invalid JSON`)
  const built = BUILDERS[name](body)
  if (built.count === 0) throw new Error(`${url} returned no prices`)
  return built
}

/** Fetch every enabled source and store one merged, priority-ordered table. */
export async function refreshPricing({ config, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const order = pricingOrder(config)
  if (order.length === 0) throw new Error("pricing.source is off")
  const previous = readPricingCache(env)
  const prices = { ...(previous?.prices ?? {}) }
  const byId = { ...(previous?.byId ?? {}) }
  const sources = {}
  const errors = []
  let count = 0

  for (const name of order) {
    try {
      const built = await fetchSource(name, config, fetchImpl)
      for (const [key, tiers] of Object.entries(built.prices)) if (!prices[key]) prices[key] = tiers
      for (const [key, tiers] of Object.entries(built.byId)) if (!byId[key]) byId[key] = tiers
      sources[name] = { url: PRICING_SOURCES[name].url, fetchedAt: Date.now(), count: built.count }
      count = Object.keys(prices).length
    } catch (error) {
      errors.push(`${name}: ${error?.message ?? error}`)
    }
  }

  if (Object.keys(sources).length === 0) {
    throw new Error(`pricing refresh failed (${errors.join("; ")})`)
  }
  return writePricingCache(
    {
      source: Object.keys(sources).join("+"),
      fetchedAt: Date.now(),
      count: Object.keys(prices).length,
      prices,
      byId,
      sources,
      errors,
    },
    env,
  )
}

export function pricingIsStale(config, cache, now = Date.now()) {
  if (!cache) return true
  const hours = Number(config?.pricing?.refreshHours)
  const ttl = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000
  return now - Number(cache.fetchedAt ?? 0) > ttl
}

/** Refresh only when the source is enabled and the cache is stale. */
export async function refreshPricingIfStale({ config, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (pricingSource(config) === "off") return null
  const cache = readPricingCache(env)
  if (!pricingIsStale(config, cache)) return cache
  return refreshPricing({ config, env, fetchImpl })
}

/** Pricing fallback for routing and display; null when disabled or uncached. */
export function loadPricing({ config, env = process.env } = {}) {
  if (pricingSource(config) === "off") return null
  return readPricingCache(env)
}

/** External tiers for one catalog model, or null when the sources have none. */
export function priceForModel(prices, model) {
  if (!prices) return null
  const id = model?.id ?? model?.modelID
  if (!id) return null
  const key = model?.providerID ? `${model.providerID}/${id}` : ""
  return (key && prices.prices?.[key]) || prices.byId?.[normalizeModelName(id)] || null
}
