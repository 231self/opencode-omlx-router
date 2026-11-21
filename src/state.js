import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DECISION_LIMIT_BYTES = 5 * 1024 * 1024
const TURN_LIMIT_BYTES = 5 * 1024 * 1024

export function stateRoot(env = process.env) {
  return env.OMLX_ROUTER_STATE || path.join(os.homedir(), ".local", "state", "omlx-router")
}

export function hostStateDir(host, env = process.env) {
  return path.join(stateRoot(env), host)
}

export function pinsDir(host, env = process.env) {
  return path.join(hostStateDir(host, env), "pins")
}

export function decisionsPath(host, env = process.env) {
  return path.join(hostStateDir(host, env), "decisions.jsonl")
}

export function statsPath(host, env = process.env) {
  return path.join(hostStateDir(host, env), "stats.json")
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Write JSON atomically: temp file in the same directory, then rename. */
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

/** Read JSON; `undefined` when the file does not exist. Throws on invalid JSON. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
}

export function sessionHash(sessionID) {
  return crypto.createHash("sha256").update(String(sessionID)).digest("hex").slice(0, 12)
}

export function pinFile(host, sessionID, env = process.env) {
  return path.join(pinsDir(host, env), `${sessionHash(sessionID)}.json`)
}

export function writePin(host, sessionID, pin, env = process.env) {
  writeJsonAtomic(pinFile(host, sessionID, env), { session: sessionHash(sessionID), ...pin })
}

export function readPin(host, sessionID, env = process.env) {
  return readJson(pinFile(host, sessionID, env))
}

/**
 * Routing state held per session. The measured context size is session
 * knowledge rather than a pin, so releasing a pin keeps the measurement
 * and any outstanding compaction guard.
 */
function preservedContext(pin) {
  const keep = {}
  if (!pin || typeof pin !== "object") return keep
  if (Number(pin.lastContextTokens) > 0) keep.lastContextTokens = Number(pin.lastContextTokens)
  if (pin.lastOptimiser) keep.lastOptimiser = pin.lastOptimiser
  if (pin.downgradeCompaction) keep.downgradeCompaction = pin.downgradeCompaction
  return keep
}

export function clearPin(host, sessionID, env = process.env) {
  const file = pinFile(host, sessionID, env)
  let keep = {}
  try {
    keep = preservedContext(readJson(file))
  } catch {
    // Remove unreadable routing state.
  }
  if (Object.keys(keep).length > 0) {
    writeJsonAtomic(file, { session: sessionHash(sessionID), ...keep })
    return
  }
  try {
    fs.rmSync(file)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
}

/** Remove every pin for a host (used when the policy changes). */
export function clearPins(host, env = process.env) {
  let entries
  try {
    entries = fs.readdirSync(pinsDir(host, env))
  } catch (error) {
    if (error.code === "ENOENT") return 0
    throw error
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue
    const file = path.join(pinsDir(host, env), entry)
    try {
      const pin = readJson(file)
      const keep = preservedContext(pin)
      if (Object.keys(keep).length > 0) {
        writeJsonAtomic(file, { session: pin.session, ...keep })
      } else {
        fs.rmSync(file)
      }
      removed += 1
    } catch {
      // best effort
    }
  }
  return removed
}

export function listPins(host, env = process.env) {
  let entries
  try {
    entries = fs.readdirSync(pinsDir(host, env))
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
  const pins = []
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue
    try {
      pins.push(readJson(path.join(pinsDir(host, env), entry)))
    } catch {
      // A corrupt pin must never break routing or status.
    }
  }
  return pins.filter((pin) => pin?.model || pin?.blocked?.length || pin?.downgradeCompaction)
}

export function appendDecision(host, record, env = process.env) {
  const file = decisionsPath(host, env)
  ensureDir(path.dirname(file))
  try {
    if (fs.statSync(file).size > DECISION_LIMIT_BYTES) fs.renameSync(file, `${file}.1`)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`)
}

export function readDecisions(host, limit = 20, env = process.env) {
  let text
  try {
    text = fs.readFileSync(decisionsPath(host, env), "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
  const lines = text.split("\n").filter(Boolean)
  const slice = limit > 0 ? lines.slice(-limit) : lines
  const out = []
  for (const line of slice) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // Skip corrupt lines rather than hiding the rest of the log.
    }
  }
  return out
}

export function turnsPath(host, env = process.env) {
  return path.join(hostStateDir(host, env), "turns.jsonl")
}

export function appendTurn(host, record, env = process.env) {
  const file = turnsPath(host, env)
  ensureDir(path.dirname(file))
  try {
    if (fs.statSync(file).size > TURN_LIMIT_BYTES) fs.renameSync(file, `${file}.1`)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`)
}

export function readTurns(host, limit = 50, env = process.env) {
  let text
  try {
    text = fs.readFileSync(turnsPath(host, env), "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
  const lines = text.split("\n").filter(Boolean)
  const slice = limit > 0 ? lines.slice(-limit) : lines
  const out = []
  for (const line of slice) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // Skip corrupt lines rather than hiding the rest of the log.
    }
  }
  return out
}

/** The most recent turn record for one session hash, or null. */
export function latestTurnFor(host, session, env = process.env) {
  const wanted = String(session ?? "")
  const turns = readTurns(host, 1000, env)
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.session === wanted) return turns[index]
  }
  return null
}

const TIMING_METRICS = [
  "turnMs",
  "routeMs",
  "judgeMs",
  "coreMs",
  "switchMs",
  "executionMs",
  "modelMs",
  "toolMs",
  "ttftMs",
]

function numbers(values) {
  return values.map(Number).filter((value) => Number.isFinite(value) && value >= 0)
}

function mean(values) {
  if (values.length === 0) return 0
  return values.reduce((total, value) => total + value, 0) / values.length
}

function percentile(values, fraction) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/** Aggregate the last turns so the CLI can show local-judge vs remote-model time. */
export function summariseTurns(turns, window = 20) {
  const recent = (turns ?? []).slice(-window)
  const summary = {
    count: recent.length,
    window: Math.min(window, recent.length),
    averages: {},
    p50: {},
    max: {},
    shares: {},
  }
  for (const metric of TIMING_METRICS) {
    const values = numbers(recent.map((turn) => turn?.[metric]))
    summary.averages[metric] = Math.round(mean(values))
    summary.p50[metric] = Math.round(percentile(values, 0.5))
    summary.max[metric] = values.length > 0 ? Math.round(Math.max(...values)) : 0
  }
  const total = summary.averages.turnMs
  if (total > 0) {
    summary.shares.local = summary.averages.routeMs / total
    summary.shares.judge = summary.averages.judgeMs / total
    summary.shares.model = summary.averages.modelMs / total
    summary.shares.tools = summary.averages.toolMs / total
    summary.shares.other = Math.max(
      0,
      1 - summary.shares.local - summary.shares.model - summary.shares.tools,
    )
  }
  return summary
}

export function writeStats(host, stats, env = process.env) {
  writeJsonAtomic(statsPath(host, env), stats)
}

export function readStats(host, env = process.env) {
  try {
    return readJson(statsPath(host, env)) ?? null
  } catch {
    return null
  }
}
