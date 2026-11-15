#!/usr/bin/env node
import { configPath, getConfigValue, readConfig, saveConfig, setConfigValue } from "../src/config.js"
import { buildStatus, formatStatus } from "../src/status.js"
import { readDecisions } from "../src/state.js"
import { VERSION } from "../src/version.js"
import { loadCore } from "../src/wasm.js"

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
const [command = "status", ...rest] = withoutJson

function usage() {
  console.log(`omlx-router ${VERSION}

Usage:
  omlx-router [status] [--json] [--host opencode|kilo]
  omlx-router config get <key>
  omlx-router config set <key> <value>
  omlx-router history [n] [--json]
  omlx-router pool
  omlx-router doctor
  omlx-router version

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
    if (!key) throw new Error("config get needs a key, e.g. policy or judge.model")
    const value = getConfigValue(config, key)
    console.log(wantsJson ? JSON.stringify(value, null, 2) : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value))
    return
  }
  if (action === "set") {
    const key = rest[1]
    const raw = rest.slice(2).join(" ")
    if (!key || raw === "") throw new Error("config set needs <key> <value>")
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
  throw new Error(`unknown config action: ${action}`)
}

function historyCommand() {
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
    console.log(
      `${when}  ${role.padEnd(14)} ${String(record.chosen ?? "?").padEnd(36)} ${
        record.pinned ? "pinned " : "switched"
      } ${record.stage ?? ""}`,
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
  console.log("note     the live pool is resolved by the host adapter and shown with /router pool")
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
  } catch (error) {
    console.log(`judge    ${base} -> ${controller.signal.aborted ? "timeout" : String(error?.message ?? error)}`)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
  }
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
    case "pool":
      poolCommand()
      break
    case "doctor":
      await doctorCommand()
      break
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION)
      break
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
  console.error(`omlx-router: ${error?.message ?? error}`)
  process.exitCode = 1
}
