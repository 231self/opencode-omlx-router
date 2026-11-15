import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DECISION_LIMIT_BYTES = 5 * 1024 * 1024

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

export function clearPin(host, sessionID, env = process.env) {
  try {
    fs.rmSync(pinFile(host, sessionID, env))
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
    try {
      fs.rmSync(path.join(pinsDir(host, env), entry))
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
  return pins.filter(Boolean)
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
