import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  appendDecision,
  appendTurn,
  clearPin,
  decisionsPath,
  hostStateDir,
  latestTurnFor,
  listPins,
  pinFile,
  readDecisions,
  readJson,
  readPin,
  readStats,
  sessionHash,
  writeJsonAtomic,
  writePin,
  writeStats,
} from "../src/state.js"

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-state-"))
  return { dir, env: { OMLX_ROUTER_STATE: path.join(dir, "state") } }
}

test("writeJsonAtomic creates parents and round-trips", () => {
  const { dir } = tempEnv()
  const file = path.join(dir, "nested", "value.json")
  writeJsonAtomic(file, { hello: "world" })
  expect(readJson(file)).toEqual({ hello: "world" })
})

test("readJson returns undefined for a missing file", () => {
  const { dir } = tempEnv()
  expect(readJson(path.join(dir, "nope.json"))).toBeUndefined()
})

test("sessionHash is stable and 12 hex chars", () => {
  const first = sessionHash("ses_abc")
  expect(first).toBe(sessionHash("ses_abc"))
  expect(first).toMatch(/^[0-9a-f]{12}$/)
  expect(first).not.toBe(sessionHash("ses_abd"))
})

test("pins are per session and removable", () => {
  const { env } = tempEnv()
  const host = "opencode"
  expect(listPins(host, env)).toEqual([])
  writePin(host, "ses_abc", { model: { providerID: "deepseek", id: "deepseek-flash" } }, env)
  expect(readPin(host, "ses_abc", env).model.id).toBe("deepseek-flash")
  expect(listPins(host, env).length).toBe(1)
  expect(fs.existsSync(pinFile(host, "ses_abc", env))).toBe(true)
  clearPin(host, "ses_abc", env)
  expect(readPin(host, "ses_abc", env)).toBeUndefined()
  expect(listPins(host, env)).toEqual([])
})

test("decisions append and tail", () => {
  const { env } = tempEnv()
  const host = "kilo"
  for (let index = 0; index < 3; index += 1) {
    appendDecision(host, { ts: index, chosen: `model-${index}`, host }, env)
  }
  const tail = readDecisions(host, 2, env)
  expect(tail.map((record) => record.chosen)).toEqual(["model-1", "model-2"])
  expect(fs.existsSync(decisionsPath(host, env))).toBe(true)
})

test("corrupt decision lines are skipped", () => {
  const { env } = tempEnv()
  const host = "opencode"
  appendDecision(host, { ts: 1, chosen: "ok" }, env)
  fs.appendFileSync(decisionsPath(host, env), "{ broken\n")
  appendDecision(host, { ts: 2, chosen: "ok-2" }, env)
  expect(readDecisions(host, 10, env).map((record) => record.chosen)).toEqual(["ok", "ok-2"])
})

test("stats round-trip and tolerate corruption", () => {
  const { env } = tempEnv()
  const host = "opencode"
  writeStats(host, { decisions: 4 }, env)
  expect(readStats(host, env)).toEqual({ decisions: 4 })
  fs.writeFileSync(path.join(hostStateDir(host, env), "stats.json"), "not json")
  expect(readStats(host, env)).toBeNull()
})

test("latestTurnFor returns the newest record for one session", () => {
  const { env } = tempEnv()
  const host = "opencode"
  const mine = sessionHash("ses_1")
  const other = sessionHash("ses_2")
  appendTurn(host, { ts: 1, session: other, usedModel: "a/b" }, env)
  appendTurn(host, { ts: 2, session: mine, usedModel: "deepseek/deepseek-flash" }, env)
  appendTurn(host, { ts: 3, session: other, usedModel: "c/d" }, env)
  appendTurn(host, { ts: 4, session: mine, usedModel: "deepseek/deepseek-v4-pro" }, env)
  expect(latestTurnFor(host, mine, env).usedModel).toBe("deepseek/deepseek-v4-pro")
  expect(latestTurnFor(host, sessionHash("ses_none"), env)).toBeNull()
})
