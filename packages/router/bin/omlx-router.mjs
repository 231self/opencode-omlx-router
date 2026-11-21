#!/usr/bin/env node
import { createInterface } from "node:readline/promises"

import { configPath, getConfigValue, readConfig, saveConfig, setConfigValue } from "../src/config.js"
import { Judge } from "../src/judge.js"
import {
  Provisioner,
  confirmThenPull,
  detectProvisioning,
  formatBytes,
  judgeAvailability,
  provisionHint,
} from "../src/provision.js"
import { readHostModelState } from "../src/pool.js"
import { loadPricing, priceForModel, pricingCachePath, refreshPricing } from "../src/pricing.js"
import {
  qualityCacheAgeMs,
  qualityCachePath,
  qualitySource,
  readQualityCache,
  refreshQuality,
} from "../src/quality.js"
import { buildStatus, formatMilliseconds, formatStatus, formatTiming } from "../src/status.js"
import { clearPins, listPins, readDecisions, readTurns, summariseTurns } from "../src/state.js"
import { ABI_VERSION, VERSION } from "../src/version.js"
import { loadCore } from "../src/wasm.js"
import { collectDebug, formatDebug } from "../src/debug.js"

const argv = process.argv.slice(2)

function takeFlag(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return [undefined, args]
  const value = args[index + 1]
  return [value, [...args.slice(0, index), ...args.slice(index + 2)]]
}

function hasFlag(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return [false, args]
  return [true, [...args.slice(0, index), ...args.slice(index + 1)]]
}

const [hostFlag, withoutHost] = takeFlag(argv, "--host")
const host = hostFlag || process.env.OMLX_ROUTER_HOST || "opencode"
const [wantsJson, withoutJson] = hasFlag(withoutHost, "--json")
const [assumeYes, withoutYes] = hasFlag(withoutJson, "--yes")
const [command = "status", ...rest] = withoutYes

/** Usage lines for commands that take optional parameters. */
const COMMAND_USAGE = {
  config: "opencode-model-router config [get <key>|set <key> <value>|path]",
  history: "opencode-model-router history [n]",
  timing: "opencode-model-router timing [n]",
  quality: "opencode-model-router quality [status|refresh]",
  pricing: "opencode-model-router pricing [refresh|provider/model]",
  pins: "opencode-model-router pins [clear]",
  judge: "opencode-model-router judge [pull|status|cancel|probe]",
}

/** An unrecognised parameter: say what was wrong, then what is allowed. */
function usageError(name, detail) {
  return new Error(`${detail}\nusage: ${COMMAND_USAGE[name]}`)
}

function usage() {
  console.log(`opencode-model-router ${VERSION}

Usage:
  opencode-model-router [status] [--json] [--host opencode|kilo]
  opencode-model-router config get <key>
  opencode-model-router config set <key> <value>
  opencode-model-router history [n] [--json]
  opencode-model-router timing [n] [--json]
  opencode-model-router pool
  opencode-model-router quality [status|refresh]
  opencode-model-router pricing [refresh|provider/model]
  opencode-model-router pins [clear] [--yes]
  opencode-model-router doctor
  opencode-model-router debug [--json]
  opencode-model-router judge pull [repo] [--yes]
  opencode-model-router judge status
  opencode-model-router judge cancel [task]
  opencode-model-router judge probe
  opencode-model-router version

Environment:
  OMLX_ROUTER_CONFIG   override config path
  OMLX_ROUTER_STATE    override state root
  OMLX_ROUTER_HOST     default host (opencode|kilo)`)
}

function resolveSecret(value) {
  if (typeof value !== "string") return undefined
  const match = value.match(/^\{env:([A-Z0-9_]+)\}$/i)
  if (match) return process.env[match[1]]
  return value || undefined
}

async function coreInfo() {
  try {
    const core = await loadCore()
    return { abi: core.abi, path: core.path }
  } catch (error) {
    return { abi: null, error: String(error?.message ?? error) }
  }
}

async function statusCommand() {
  const status = buildStatus({ host, core: await coreInfo() })
  if (wantsJson) console.log(JSON.stringify(status, null, 2))
  else console.log(formatStatus(status))
}

function configCommand() {
  const action = rest[0] ?? "get"
  const { config, path } = readConfig({ write: false })
  if (action === "path") {
    console.log(path)
    return
  }
  if (action === "get") {
    const key = rest[1]
    if (!key) throw usageError("config", "config get needs a key, e.g. policy or judge.model")
    const value = getConfigValue(config, key)
    console.log(wantsJson ? JSON.stringify(value, null, 2) : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value))
    return
  }
  if (action === "set") {
    const key = rest[1]
    const raw = rest.slice(2).join(" ")
    if (!key || raw === "") throw usageError("config", "config set needs <key> <value>")
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      value = raw
    }
    const saved = saveConfig(setConfigValue(config, key, value))
    console.log(`set ${key} = ${JSON.stringify(getConfigValue(saved, key))}`)
    console.log(`config ${configPath()}`)
    return
  }
  throw usageError("config", `unknown config action: ${action}`)
}

function historyCommand() {
  if (rest[0] !== undefined && !Number.isFinite(Number(rest[0]))) {
    throw usageError("history", `"${rest[0]}" is not a number`)
  }
  const limit = Number(rest[0] ?? 20)
  const decisions = readDecisions(host, Number.isFinite(limit) ? limit : 20)
  if (wantsJson) {
    console.log(JSON.stringify(decisions, null, 2))
    return
  }
  if (decisions.length === 0) {
    console.log("no decisions recorded yet")
    return
  }
  for (const record of decisions) {
    const when = new Date(record.ts ?? Date.now()).toISOString()
    const role = record.role === "subagent" ? `sub(${record.agent ?? "?"})` : "root"
    const timing = record.timing ?? {}
    console.log(
      `${when}  ${role.padEnd(14)} ${String(record.chosen ?? "?").padEnd(36)} ${
        record.pinned ? "pinned " : "switched"
      } ${record.stage ?? ""}  judge ${formatMilliseconds(timing.judgeMs ?? record.judge?.ms ?? 0)} route ${formatMilliseconds(timing.routeMs ?? 0)}`,
    )
  }
}

function modelRefLabel(reference) {
  if (!reference) return "none"
  return `${reference.providerID}/${reference.id ?? reference.modelID}${reference.variant ? `#${reference.variant}` : ""}`
}

function pinsCommand() {
  if (rest[0] && rest[0] !== "clear") {
    throw usageError("pins", `unknown parameter "${rest[0]}"`)
  }
  const pins = listPins(host)
  if (rest[0] === "clear") {
    if (pins.length === 0) {
      console.log("no routing pins")
      return
    }
    if (!assumeYes) {
      console.log(`clear ${pins.length} pins with: opencode-model-router pins clear --yes`)
      return
    }
    clearPins(host)
    console.log(`cleared ${pins.length} pins`)
    return
  }
  if (pins.length === 0) {
    console.log("no routing pins")
    return
  }
  const sorted = [...pins].sort(
    (left, right) => (Number(right.lastTurnAt) || 0) - (Number(left.lastTurnAt) || 0),
  )
  console.log(`${pins.length} sessions with routing state`)
  for (const pin of sorted) {
    const when = Number(pin.lastTurnAt) || Number(pin.since) || 0
    const age = when ? `${Math.max(0, Math.round((Date.now() - when) / 60000))}m` : "?"
    const blocks = (Array.isArray(pin.blocked) ? pin.blocked : []).filter(
      (block) => block && Number(block.until) > Date.now(),
    )
    const blocked = blocks.length
      ? `  blocked ${blocks
          .map((block) => `${block.providerID}/${block.id}${block.providerWide ? " (provider)" : ""}`)
          .join(", ")}`
      : ""
    console.log(`${modelRefLabel(pin.model).padEnd(42)} ${pin.forced ? "manual" : "auto"}  ${age} old${blocked}`)
  }
}

function timingCommand() {
  if (rest[0] !== undefined && !Number.isFinite(Number(rest[0]))) {
    throw usageError("timing", `"${rest[0]}" is not a number`)
  }
  const limit = Number(rest[0] ?? 20)
  const turns = readTurns(host, Number.isFinite(limit) ? limit : 20)
  const summary = summariseTurns(turns, Number.isFinite(limit) ? limit : 20)
  if (wantsJson) {
    console.log(JSON.stringify({ summary, turns }, null, 2))
    return
  }
  if (turns.length === 0) {
    console.log("no turn timings recorded yet; send a prompt first")
    return
  }
  console.log(formatTiming(summary) ?? "no turn timings recorded yet")
  console.log("")
  for (const turn of turns.slice(-10)) {
    const when = new Date(turn.ts ?? Date.now()).toLocaleTimeString()
    const role = turn.role === "subagent" ? `sub(${turn.agent || "?"})` : "root"
    console.log(
      `${when}  ${role.padEnd(14)} ${String(turn.usedModel ?? turn.model ?? "?").padEnd(36)} ` +
        `judge ${formatMilliseconds(turn.judgeMs).padEnd(7)} model ${formatMilliseconds(turn.modelMs).padEnd(7)} ` +
        `tools ${formatMilliseconds(turn.toolMs).padEnd(7)} turn ${formatMilliseconds(turn.turnMs)}`,
    )
  }
}

function poolCommand() {
  const { config } = readConfig({ write: false })
  console.log(`source   ${config.pool.source}`)
  console.log(`max      ${config.pool.maxModels}`)
  console.log(`tools    ${config.pool.requireTools ? "required" : "optional"}`)
  console.log(`context  >= ${config.pool.minContext}`)
  if (config.pool.models.length) console.log(`models   ${config.pool.models.join(", ")}`)
  if (config.pool.include.length) console.log(`include  ${config.pool.include.join(", ")}`)
  if (config.pool.exclude.length) console.log(`exclude  ${config.pool.exclude.join(", ")}`)
  const state = readHostModelState(host)
  if (config.pool.source === "favorites" && state.favorite.length === 0) {
    console.log("warning  no favorites; routing pauses until you favorite models or set pool.models")
  }
  if (config.pool.source === "list" && config.pool.models.length === 0) {
    console.log("warning  pool.models is empty; routing pauses until you add models")
  }
  console.log(`config   ${configPath()}`)
  console.log("set models: opencode-model-router config set pool.source list")
  console.log(`            opencode-model-router config set pool.models '["provider/model", "..."]'`)
  console.log("note     the live pool is resolved by the host adapter and shown with /router pool")
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(question)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

function taskLine(task) {
  const total = Number(task.total_size) || 0
  const done = Number(task.downloaded_size) || 0
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : Number(task.progress) || 0
  return `${task.repo_id} · ${task.status} · ${percent}% (${formatBytes(done)} / ${formatBytes(total)})`
}

async function judgeCommand() {
  const action = rest[0] ?? "status"
  if (!["pull", "status", "cancel", "probe"].includes(action)) {
    throw usageError("judge", `unknown parameter "${action}"`)
  }
  const { config } = readConfig({ write: true })
  const provision = new Provisioner({ config })

  if (["pull", "status", "cancel"].includes(action)) {
    const backend = await detectProvisioning({ config })
    if (!backend.supported) {
      console.log(provisionHint(config))
      return
    }
  }

  if (action === "status") {
    const tasks = await provision.tasks()
    if (tasks.length === 0) {
      console.log("no judge downloads")
      return
    }
    for (const task of tasks) console.log(taskLine(task))
    return
  }

  if (action === "cancel") {
    const tasks = await provision.tasks()
    const active = tasks.filter((task) => ["pending", "downloading"].includes(task.status))
    const target = rest[1] ? tasks.find((task) => task.task_id === rest[1]) : active[0]
    if (!target) {
      console.log(rest[1] ? `no task ${rest[1]}` : "no active download")
      process.exitCode = 1
      return
    }
    await provision.cancel(target.task_id)
    console.log(`cancelled ${target.repo_id} (${target.task_id})`)
    return
  }

  if (action === "probe") {
    const availability = await judgeAvailability({ config })
    if (!availability.available) {
      console.log(`judge unavailable: ${availability.error ?? "no models"}`)
      process.exitCode = 1
      return
    }
    const judge = new Judge({ config: config.judge })
    const probe = await judge.probe()
    console.log(`models   ${probe.models.join(", ")}`)
    console.log(`selected ${probe.selected}`)
    console.log(`suitable ${availability.suitable ? "yes" : "no"}`)
    console.log(`latency  ${probe.ms} ms`)
    if (probe.sample) console.log(`sample   ${JSON.stringify(probe.sample)}`)
    return
  }

  if (action !== "pull") {
    throw new Error(`unknown judge action: ${action}`)
  }
  if (config.judge.provision?.enabled === false) {
    throw new Error("judge provisioning is disabled (judge.provision.enabled)")
  }

  const repo = rest.slice(1).find((value) => !value.startsWith("--"))
  const result = await confirmThenPull({
    provision,
    repo,
    confirm: async (summary) => {
      console.log(`Model    ${summary.repo}`)
      if (summary.params) console.log(`Params   ${summary.params}`)
      console.log(`Weights  ${summary.weightsFormatted}`)
      console.log(`Download ${summary.sizeFormatted} (all files)`)
      console.log(`License  ${summary.license}`)
      console.log(`Source   Hugging Face · MLX: ${summary.mlx ? "yes" : "no"}`)
      if (assumeYes) return true
      return ask("Download into oMLX and serve it locally? [y/N] ")
    },
  })

  if (!result.approved) {
    console.log("cancelled")
    return
  }

  console.log(`started ${result.task.repo_id} (${result.task.task_id})`)
  let lastPercent = -1
  const task = await provision.waitFor(result.task.task_id, {
    onProgress: (progress) => {
      const total = Number(progress.total_size) || 0
      const done = Number(progress.downloaded_size) || 0
      const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : Number(progress.progress) || 0
      if (percent !== lastPercent) {
        lastPercent = percent
        console.log(`${progress.status.padEnd(11)} ${String(percent).padStart(3)}%  ${formatBytes(done)} / ${formatBytes(total)}`)
      }
    },
  })

  if (task.status !== "completed") {
    console.error(`download ${task.status}: ${task.error || "no detail"}`)
    process.exitCode = 1
    return
  }

  console.log(`completed ${task.repo_id}`)
  const availability = await judgeAvailability({ config })
  if (!availability.available) {
    console.log("download completed, but oMLX has not advertised a model yet; reload models in the oMLX app")
    return
  }
  console.log(`judge    ${availability.selected}${availability.suitable ? "" : " (larger than the recommended 4B class)"}`)
}

async function doctorCommand() {
  const { config } = readConfig({ write: false })
  const base = String(config.judge.baseURL).replace(/\/+$/, "")
  const apiKey = resolveSecret(config.judge.apiKey)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(250, Number(config.judge.timeoutMs) || 1500))
  const started = Date.now()
  try {
    const response = await fetch(`${base}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    })
    const elapsed = Date.now() - started
    if (!response.ok) {
      console.log(`judge    ${base} -> HTTP ${response.status}`)
      process.exitCode = 1
      return
    }
    const body = await response.json()
    const models = (body?.data ?? []).map((model) => model.id).filter(Boolean)
    console.log(`judge    ${base} -> ${models.length} model(s) in ${elapsed} ms`)
    if (models.length) console.log(`models   ${models.join(", ")}`)
    console.log(`selected ${config.judge.model}`)
    const availability = await judgeAvailability({ config })
    const backend = await detectProvisioning({ config }).catch((error) => ({
      supported: false,
      backend: "unknown",
      reason: String(error?.message ?? error),
    }))
    if (!availability.suitable) {
      console.log(
        `hint     no ~4B judge detected; ${
          backend.supported ? "run: opencode-model-router judge pull" : "start a small model on your server"
        }`,
      )
    }
    console.log(
      `downloads ${backend.supported ? backend.backend : `unavailable (${backend.reason})`}`,
    )
  } catch (error) {
    console.log(`judge    ${base} -> ${controller.signal.aborted ? "timeout" : String(error?.message ?? error)}`)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
  }
}

function priceLine(tiers) {
  const tier = Array.isArray(tiers) ? tiers[0] : null
  if (!tier) return "unknown (no pricing data)"
  const parts = []
  if (tier.input !== undefined) parts.push(`in $${tier.input}`)
  if (tier.output !== undefined) parts.push(`out $${tier.output}`)
  if (tier.cache?.read !== undefined) parts.push(`cache read $${tier.cache.read}`)
  return parts.length > 0 ? `${parts.join(" · ")} /M` : "unknown (no pricing data)"
}

async function pricingCommand() {
  const action = rest[0] ?? "status"
  const { config } = readConfig({ write: false })
  if (action !== "status" && action !== "refresh" && !action.includes("/")) {
    throw usageError("pricing", `unknown parameter "${action}"`)
  }
  if (action === "refresh") {
    try {
      const cache = await refreshPricing({ config })
      console.log(`refreshed ${cache.source} · ${cache.count} models`)
      console.log(`cache ${pricingCachePath()}`)
    } catch (error) {
      console.error(`pricing refresh failed: ${error?.message ?? error}`)
      process.exitCode = 1
    }
    return
  }
  const cache = loadPricing({ config })
  if (!cache) {
    console.log("cache  none; run: opencode-model-router pricing refresh")
    return
  }
  if (action !== "status") {
    const [providerID, ...segments] = action.split("#")[0].split("/")
    const tiers = priceForModel(cache, { providerID, id: segments.join("/") })
    console.log(`${action}  ${priceLine(tiers)}`)
    if (!tiers) {
      console.log(`source ${cache.source} · no entry for this model`)
      process.exitCode = 1
    }
    return
  }
  console.log(`source ${cache.source}`)
  console.log(`models ${cache.count}`)
  for (const [name, entry] of Object.entries(cache.sources ?? {})) {
    const minutes = Math.floor(Math.max(0, Date.now() - Number(entry.fetchedAt ?? 0)) / 60_000)
    console.log(
      `${name.padEnd(9)} ${entry.count} models · ${minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`} old`,
    )
  }
  console.log(`cache  ${pricingCachePath()}`)
}

async function qualityCommand() {
  const action = rest[0] ?? "status"
  const { config } = readConfig({ write: false })
  if (action !== "status" && action !== "refresh") {
    throw usageError("quality", `unknown parameter "${action}"`)
  }
  if (action === "refresh") {
    try {
      const cache = await refreshQuality({ config })
      const names = Object.keys(cache.sources ?? {}).join(" + ")
      console.log(`refreshed ${cache.source}${names ? ` (${names})` : ""} · ${cache.count} models`)
      console.log(`cache ${qualityCachePath()}`)
    } catch (error) {
      console.error(`quality refresh failed: ${error?.message ?? error}`)
      process.exitCode = 1
    }
    return
  }
  const source = qualitySource(config)
  const cache = readQualityCache()
  console.log(`source ${source}`)
  if (!cache) {
    console.log("cache  none; run: opencode-model-router quality refresh")
    return
  }
  for (const [name, entry] of Object.entries(cache.sources ?? {})) {
    const minutes = Math.floor((Number(qualityCacheAgeMs(entry)) || 0) / 60_000)
    console.log(`${name.padEnd(7)} ${entry.count} models · ${minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`} old`)
  }
  console.log(`models ${cache.count}`)
  console.log(`cache  ${qualityCachePath()}`)
}

async function debugCommand() {
  const info = await collectDebug({ host, core: await coreInfo() })
  if (wantsJson) {
    console.log(JSON.stringify(info, null, 2))
    return
  }
  console.log(formatDebug(info))
}

try {
  switch (command) {
    case "status":
      await statusCommand()
      break
    case "config":
      configCommand()
      break
    case "history":
      historyCommand()
      break
    case "timing":
      timingCommand()
      break
    case "pool":
      poolCommand()
      break
    case "doctor":
      await doctorCommand()
      break
    case "quality":
      await qualityCommand()
      break
    case "pricing":
      await pricingCommand()
      break
    case "pins":
      pinsCommand()
      break
    case "debug":
      await debugCommand()
      break
    case "judge":
      await judgeCommand()
      break
    case "version":
    case "--version":
    case "-v": {
      if (wantsJson) {
        const core = await coreInfo()
        console.log(
          JSON.stringify(
            {
              name: "opencode-router",
              version: VERSION,
              abi: core.abi ?? ABI_VERSION,
              host,
              core: core.path ? core : null,
            },
            null,
            2,
          ),
        )
        break
      }
      console.log(VERSION)
      break
    }
    case "help":
    case "--help":
    case "-h":
      usage()
      break
    default:
      usage()
      process.exitCode = 1
  }
} catch (error) {
  console.error(`opencode-router: ${error?.message ?? error}`)
  process.exitCode = 1
}
