import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { writeJsonAtomic } from "./state.js"

export const DEFAULT_CONFIG = {
  enabled: true,
  policy: "cost",
  pool: {
    source: "favorites",
    models: [],
    include: [],
    exclude: [],
    maxModels: 8,
    requireTools: true,
    minContext: 32000,
  },
  judge: {
    enabled: true,
    baseURL: "http://127.0.0.1:1234/v1",
    model: "auto",
    apiKey: "{env:OMLX_API_KEY}",
    timeoutMs: 1500,
    cacheTtlMs: 600000,
    cacheSize: 128,
  },
  pin: {
    switchThreshold: 0.12,
    idleTtlMs: 300000,
    flipFlopTurns: 3,
    cacheHitRatio: 0.8,
  },
  optimiser: {
    enabled: true,
    reserveOutputTokens: 8192,
    safetyTokens: 1024,
    maxToolTokens: 2000,
    keepRecentToolOutputs: 3,
    keepRecentTurns: 2,
  },
  limits: {
    shortfallTolerance: 0.2,
    allowLocalForComplexity: 2,
    expectedOutputTokens: 1200,
    contextFitRatio: 0.9,
  },
  quality: { overrides: {} },
  latency: { overrides: {}, localProviders: [] },
  subagents: {
    enabled: true,
    overrideExplicitModel: false,
    default: { policy: "cost", qualityFloor: 0.0 },
    agents: {
      explore: { policy: "latency", qualityFloor: 0.45, minContext: 128000 },
      general: { policy: "cost", qualityFloor: 0.55 },
      review: { policy: "quality", qualityFloor: 0.75 },
      plan: { policy: "quality", qualityFloor: 0.8 },
    },
  },
  debug: false,
}

export function configPath(env = process.env) {
  return env.OMLX_ROUTER_CONFIG || path.join(os.homedir(), ".config", "omlx-router", "config.json")
}

/** Expand a `{env:NAME}` reference; an empty value means "no credential". */
export function resolveSecret(value, env = process.env) {
  if (typeof value !== "string") return undefined
  const match = value.match(/^\{env:([A-Z0-9_]+)\}$/i)
  if (match) return env[match[1]]
  return value || undefined
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Recursive merge where `override` wins; arrays and scalars replace. */
export function mergeConfig(base, override) {
  if (!isPlainObject(override)) return override === undefined ? structuredClone(base) : override
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? mergeConfig(base[key], value) : value
  }
  return out
}

/**
 * Read the shared config, seeding it from plugin options on first run.
 *
 * The file is the source of truth afterwards; `seed` is ignored when it exists.
 */
export function readConfig({ env = process.env, seed, write = true } = {}) {
  const file = configPath(env)
  let raw
  let existed = false
  let error = null
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"))
    existed = true
  } catch (cause) {
    if (cause.code !== "ENOENT") error = `invalid config: ${cause.message}`
  }

  if (!existed && !error) {
    const config = mergeConfig(DEFAULT_CONFIG, seed ?? {})
    if (write) {
      try {
        writeJsonAtomic(file, config)
      } catch (cause) {
        error = `cannot write config: ${cause.message}`
      }
    }
    return { config, path: file, existed: false, seeded: write && !error, error }
  }

  const config = mergeConfig(DEFAULT_CONFIG, isPlainObject(raw) ? raw : {})
  return { config, path: file, existed, seeded: false, error }
}

export function saveConfig(config, { env = process.env } = {}) {
  const file = configPath(env)
  const merged = mergeConfig(DEFAULT_CONFIG, config)
  writeJsonAtomic(file, merged)
  return merged
}

export function getConfigValue(config, key) {
  return key.split(".").reduce((value, part) => (value == null ? undefined : value[part]), config)
}

export function setConfigValue(config, key, value) {
  const merged = mergeConfig(DEFAULT_CONFIG, config)
  const parts = key.split(".")
  let cursor = merged
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cursor[part])) cursor[part] = {}
    cursor = cursor[part]
  }
  cursor[parts.at(-1)] = value
  return merged
}
