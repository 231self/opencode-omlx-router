import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { appendDecision, appendTurn, writePin } from "../src/state.js"
import { buildStatus, formatStatus, formatTiming, formatTuiStatus } from "../src/status.js"

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-status-"))
  return {
    dir,
    env: {
      OMLX_ROUTER_CONFIG: path.join(dir, "config.json"),
      OMLX_ROUTER_STATE: path.join(dir, "state"),
    },
  }
}

test("status on a cold install uses defaults without writing", () => {
  const { env } = tempEnv()
  const status = buildStatus({ host: "opencode", env })
  expect(status.enabled).toBe(true)
  expect(status.policy).toBe("cost")
  expect(status.pool).toBe("favorites")
  expect(status.configExists).toBe(false)
  expect(status.pins).toBe(0)
  expect(status.last).toBeNull()
  expect(fs.existsSync(env.OMLX_ROUTER_CONFIG)).toBe(false)
})

test("status reflects pins and the latest decision", () => {
  const { env } = tempEnv()
  writePin("opencode", "ses_abc", { model: { providerID: "deepseek", id: "deepseek-flash" } }, env)
  appendDecision(
    "opencode",
    { ts: Date.now(), chosen: "deepseek/deepseek-flash", stage: "judge/cost", pinned: true, role: "root" },
    env,
  )
  const status = buildStatus({ host: "opencode", env })
  expect(status.pins).toBe(1)
  expect(status.last.chosen).toBe("deepseek/deepseek-flash")
  expect(status.last.pinned).toBe(true)
})

test("formatStatus always shows the essentials", () => {
  const { env } = tempEnv()
  const text = formatStatus(buildStatus({ host: "opencode", env, core: { abi: 1 } }))
  expect(text).toContain("opencode-router 0.2.3")
  expect(text).toContain("policy cost")
  expect(text).toContain("core       ABI 1")
  expect(text).toContain("last       none")
})

test("status and formatting expose judge vs remote timing", () => {
  const { env } = tempEnv()
  appendTurn(
    "opencode",
    {
      ts: Date.now(),
      role: "root",
      model: "deepseek/deepseek-flash",
      usedModel: "deepseek/deepseek-flash",
      turnMs: 10_000,
      routeMs: 1_000,
      judgeMs: 800,
      modelMs: 7_000,
      toolMs: 2_000,
    },
    env,
  )
  const status = buildStatus({ host: "opencode", env })
  expect(status.timing.count).toBe(1)
  expect(status.lastTurn.modelMs).toBe(7_000)
  const line = formatTiming(status.timing)
  expect(line).toContain("local judge 800ms")
  expect(line).toContain("remote model 7.0s")
  expect(line).toContain("(last 1)")
  expect(formatStatus(status)).toContain("timing     local judge")
})

test("compact TUI status stays short and readable", () => {
  const { env } = tempEnv()
  appendTurn(
    "opencode",
    {
      ts: Date.now(),
      role: "root",
      turnMs: 10_000,
      routeMs: 1_000,
      judgeMs: 800,
      modelMs: 7_000,
      toolMs: 2_000,
    },
    env,
  )
  const text = formatTuiStatus(buildStatus({ host: "opencode", env }))
  const lines = text.split("\n")
  expect(lines.length).toBeLessThanOrEqual(8)
  expect(lines.every((line) => line.length < 100)).toBe(true)
  expect(text).toContain("state   enabled")
  expect(text).toContain("judge   auto")
  expect(text).toContain("timing  judge 800ms")
  expect(text).toContain("config  /")
})
