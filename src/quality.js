import fs from "node:fs"
import path from "node:path"

import { stateRoot, writeJsonAtomic } from "./state.js"

const DATASETS_SERVER = "https://datasets-server.huggingface.co/rows"
const DEFAULT_DATASET = "lmarena-ai/leaderboard-dataset"
const DEFAULT_CONFIG = "webdev"
const DEFAULT_SPLIT = "latest"
const PAGE_SIZE = 100
const MAX_PAGES = 50

export function qualityCachePath(env = process.env) {
  return env.OMLX_ROUTER_QUALITY_CACHE || path.join(stateRoot(env), "quality.json")
}

/** Normalise a model name for matching: drop qualifiers and punctuation. */
export function normalizeModelName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/^[^/]+\//, "")
    .replace(/[^a-z0-9]+/g, "")
}

/** Catalog keys to try for one model: label, id, and display name. */
export function modelKeys(model) {
  const id = model?.id ?? model?.modelID
  const label = model?.providerID && id ? `${model.providerID}/${id}` : ""
  return [...new Set([label, id, model?.name].map(normalizeModelName).filter(Boolean))]
}

export function qualityForModel(scores, model) {
  if (!scores) return null
  for (const key of modelKeys(model)) {
    if (scores[key]) return scores[key]
  }
  return null
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}

/**
 * Build quality scores from LMArena rows. Rank percentile is mapped into the
 * router's 0..1 quality scale: rank 1 -> 0.97, last -> 0.35. When a model has
 * several variants, the best rank wins.
 */
export function buildScores(rows, { source = "lmarena", config = DEFAULT_CONFIG, count } = {}) {
  const usable = (rows ?? []).filter(
    (row) =>
      row &&
      row.model_name &&
      Number.isFinite(Number(row.rank)) &&
      (!row.category || row.category === "overall"),
  )
  const total = Math.max(1, usable.length)
  const scores = {}
  for (const row of usable) {
    const key = normalizeModelName(row.model_name)
    if (!key) continue
    const rank = Number(row.rank)
    const percentile = 1 - (rank - 1) / Math.max(1, total - 1)
    const quality = round3(0.35 + 0.62 * Math.max(0, Math.min(1, percentile)))
    const current = scores[key]
    if (!current || rank < current.rank) {
      scores[key] = { quality, rank, model: row.model_name }
    }
  }
  return {
    source,
    config,
    fetchedAt: Date.now(),
    count: Number(count) || total,
    scores,
  }
}

export function readQualityCache(env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(qualityCachePath(env), "utf8"))
    if (!raw || typeof raw !== "object" || !raw.scores) return null
    return raw
  } catch {
    return null
  }
}

export function writeQualityCache(cache, env = process.env) {
  writeJsonAtomic(qualityCachePath(env), cache)
  return cache
}

export function qualityCacheAgeMs(cache, now = Date.now()) {
  return cache?.fetchedAt ? Math.max(0, now - Number(cache.fetchedAt)) : null
}

export function qualitySource(config) {
  const source = config?.quality?.source ?? "manual"
  return source === "lmarena" ? "lmarena" : "manual"
}

function datasetSettings(config) {
  const quality = config?.quality ?? {}
  return {
    dataset: quality.lmarena?.dataset ?? DEFAULT_DATASET,
    config: quality.lmarena?.config ?? quality.category ?? DEFAULT_CONFIG,
    split: quality.lmarena?.split ?? DEFAULT_SPLIT,
    timeoutMs: Math.max(1000, Number(quality.timeoutMs) || 10_000),
  }
}

async function fetchPage(settings, offset, fetchImpl) {
  const url =
    `${DATASETS_SERVER}?dataset=${encodeURIComponent(settings.dataset)}` +
    `&config=${encodeURIComponent(settings.config)}` +
    `&split=${encodeURIComponent(settings.split)}` +
    `&offset=${offset}&length=${PAGE_SIZE}`
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(settings.timeoutMs) })
  if (!response.ok) throw new Error(`LMArena rows returned HTTP ${response.status}`)
  const body = await response.json().catch(() => null)
  if (!body) throw new Error("LMArena rows returned invalid JSON")
  return body
}

/** Fetch the latest leaderboard rows and derive the score table. */
export async function refreshQuality({ config, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (qualitySource(config) !== "lmarena") {
    throw new Error("quality.source is manual; set it to lmarena to refresh")
  }
  const settings = datasetSettings(config)
  const rows = []
  let total = null
  let offset = 0
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await fetchPage(settings, offset, fetchImpl)
    const pageRows = (body.rows ?? []).map((entry) => entry?.row).filter(Boolean)
    rows.push(...pageRows)
    total = Number(body.num_rows_total) || total
    offset += pageRows.length
    if (pageRows.length === 0 || (total !== null && offset >= total)) break
  }
  if (rows.length === 0) throw new Error("LMArena returned no rows")
  const cache = buildScores(rows, { source: "lmarena", config: settings.config, count: total ?? rows.length })
  return writeQualityCache(cache, env)
}

export function qualityIsStale(config, cache, now = Date.now()) {
  if (!cache) return true
  if (cache.source !== "lmarena") return true
  const hours = Number(config?.quality?.refreshHours)
  const ttl = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000
  return now - Number(cache.fetchedAt ?? 0) > ttl
}

/** Refresh only when the source is enabled and the cache is stale. */
export async function refreshQualityIfStale({ config, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (qualitySource(config) !== "lmarena") return null
  const cache = readQualityCache(env)
  if (!qualityIsStale(config, cache)) return cache
  return refreshQuality({ config, env, fetchImpl })
}

/** Scores for routing: null when the source is manual or no cache exists. */
export function loadQualityScores({ config, env = process.env } = {}) {
  if (qualitySource(config) !== "lmarena") return null
  const cache = readQualityCache(env)
  if (!cache || cache.source !== "lmarena") return null
  return cache.scores ?? null
}

export { DEFAULT_CONFIG as DEFAULT_LMARENA_CONFIG, DEFAULT_DATASET }
