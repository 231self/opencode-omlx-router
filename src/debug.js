import os from "node:os"

import { readConfig } from "./config.js"
import { judgeAvailability } from "./provision.js"
import { qualityCacheAgeMs, qualitySource, readQualityCache } from "./quality.js"
import { readDecisions, readTurns, summariseTurns } from "./state.js"
import { buildStatus, formatMilliseconds, modelLabel } from "./status.js"
import { ABI_VERSION, VERSION } from "./version.js"

function shortPath(value) {
  const text = String(value ?? "")
  const home = os.homedir()
  return home && text.startsWith(home) ? `~${text.slice(home.length)}` : text
}

function hostLabel(value) {
  try {
    return new URL(String(value)).host
  } catch {
    return String(value ?? "")
  }
}

function safe(read, fallback) {
  try {
    return read()
  } catch {
    return fallback
  }
}

function count(value) {
  return Array.isArray(value) ? value.length : 0
}

/** A small, secret-free view of the config for diagnostics output. */
export function configDigest(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    policy: config.policy ?? "cost",
    pool: {
      source: config.pool?.source ?? "favorites",
      models: count(config.pool?.models),
      include: count(config.pool?.include),
      exclude: count(config.pool?.exclude),
      maxModels: Number(config.pool?.maxModels) || 0,
      requireTools: config.pool?.requireTools !== false,
      minContext: Number(config.pool?.minContext) || 0,
      localCostZero: config.pool?.localCostZero !== false,
    },
    judge: {
      enabled: config.judge?.enabled !== false,
      baseURL: config.judge?.baseURL ?? "",
      model: config.judge?.model ?? "auto",
      timeoutMs: Number(config.judge?.timeoutMs) || 0,
      provision: config.judge?.provision?.enabled !== false,
      provisionBackend: config.judge?.provision?.backend ?? "auto",
    },
    pin: {
      mode: config.pin?.mode ?? "balanced",
      switchThreshold: Number(config.pin?.switchThreshold) || 0,
      maxTurns: Number(config.pin?.maxTurns) || 0,
      maxAgeMs: Number(config.pin?.maxAgeMs) || 0,
      costSwitchRatio: Number(config.pin?.costSwitchRatio) || 0,
    },
    optimiser: {
      enabled: config.optimiser?.enabled !== false,
      maxToolTokens: Number(config.optimiser?.maxToolTokens) || 0,
      keepRecentToolOutputs: Number(config.optimiser?.keepRecentToolOutputs) || 0,
    },
    subagents: {
      enabled: config.subagents?.enabled !== false,
      agents: Object.keys(config.subagents?.agents ?? {}),
    },
    debug: Boolean(config.debug),
  }
}

/**
 * Read-only diagnostic bundle for `/router debug` and `omlx-router debug`.
 * Never includes secrets: the judge key is only reported as configured or not.
 */
export async function collectDebug({
  host = "opencode",
  env = process.env,
  core = null,
  checkJudge = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  const { config } = readConfig({ env, write: false })
  const status = buildStatus({ host, env, core })
  const digest = configDigest(config)
  let judge = { available: null, suitable: null, selected: null, error: "not checked" }

  if (checkJudge) {
    const timeout = Math.max(250, Number(config.judge?.timeoutMs) || 5000)
    const bounded = (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeout) })
    judge = await judgeAvailability({ config, env, fetchImpl: bounded }).then(
      (result) => ({
        available: result.available,
        suitable: result.suitable,
        selected: result.selected,
        error: result.error,
      }),
      (error) => ({ available: false, suitable: false, selected: null, error: String(error?.message ?? error) }),
    )
  }

  const cache = safe(() => readQualityCache(env), null)
  const decisions = safe(() => readDecisions(host, 1, env), [])
  const turns = safe(() => readTurns(host, 50, env), [])
  return {
    name: "opencode-omlx-router",
    version: VERSION,
    abi: ABI_VERSION,
    host,
    core: status.core ?? null,
    configPath: status.configPath,
    configExists: status.configExists,
    stateDir: status.stateDir,
    enabled: status.enabled,
    pins: status.pins,
    pinModels: status.pinModels,
    blocked: status.blocked ?? [],
    statusError: status.error ?? null,
    judge,
    quality: {
      source: qualitySource(config),
      cache: cache
        ? { config: cache.config, count: cache.count, ageMs: qualityCacheAgeMs(cache) }
        : null,
    },
    config: digest,
    lastDecision: decisions[0] ?? null,
    timing: safe(() => summariseTurns(turns, 20), null),
  }
}

export function formatDebug(info) {
  const config = info.config ?? {}
  const judge = info.judge ?? {}
  const lines = [
    `oMLX Router ${info.version} · ${info.host} · ABI ${info.abi}`,
    `core     ${info.core?.abi ? `ABI ${info.core.abi} · ${shortPath(info.core.path)}` : "not loaded"}`,
    `config   ${shortPath(info.configPath)}${info.configExists ? "" : " (not created yet)"}`,
    `state    ${shortPath(info.stateDir)}`,
    `routing  ${info.enabled ? "enabled" : "disabled"} · policy ${config.policy} · pool ${config.pool?.source}`,
    `judge    ${config.judge?.model} · ${hostLabel(config.judge?.baseURL)} · ${judgeLine(judge)}`,
    `quality  ${qualityLine(info.quality)}`,
    `pins     ${info.pins}${info.pinModels?.length ? ` · ${info.pinModels.map(modelLabel).join(", ")}` : ""}`,
  ]
  if (info.lastDecision) {
    const record = info.lastDecision
    const timing = record.timing ?? {}
    lines.push(
      `last     ${record.chosen ?? "unknown"} · ${record.stage ?? ""}${record.pinned ? " · pinned" : ""} · judge ${formatMilliseconds(timing.judgeMs ?? record.judge?.ms ?? 0)} route ${formatMilliseconds(timing.routeMs ?? 0)}`,
    )
  }
  if (info.timing?.count) {
    const average = info.timing.averages
    lines.push(
      `timing   judge ${formatMilliseconds(average.judgeMs)} · remote ${formatMilliseconds(average.modelMs)} · turn ${formatMilliseconds(average.turnMs)} (last ${info.timing.count})`,
    )
  }
  if (info.blocked?.length) {
    const blocked = info.blocked
      .slice(0, 3)
      .map((entry) => `${entry.providerID}/${entry.id} (${entry.reason})`)
      .join(", ")
    lines.push(`blocked  ${info.blocked.length} · ${blocked}`)
  }
  const pool = config.pool ?? {}
  lines.push(
    `settings enabled=${config.enabled} policy=${config.policy} pool=${pool.source}(${pool.models}) pin=${config.pin?.mode} optimiser=${config.optimiser?.enabled ? "on" : "off"} subagents=${config.subagents?.enabled ? "on" : "off"} debug=${config.debug ? "on" : "off"}`,
  )
  if (info.statusError) lines.push(`warning  ${info.statusError}`)
  return lines.join("\n")
}

function qualityLine(quality) {
  if (!quality) return "unknown"
  if (quality.source !== "lmarena") return "manual overrides"
  if (!quality.cache) return "lmarena · cache empty; run /router quality refresh"
  const minutes = Math.floor((Number(quality.cache.ageMs) || 0) / 60_000)
  const age = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
  return `lmarena · ${quality.cache.count} models · ${age} old`
}

function judgeLine(judge) {
  if (judge.available === null) return judge.error ?? "not checked"
  if (!judge.available) return `unavailable: ${judge.error ?? "no models"}`
  return `${judge.selected ?? "auto"}${judge.suitable ? "" : " (not 4B-class)"}`
}
