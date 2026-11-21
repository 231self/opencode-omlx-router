import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { measuredJudgeLatency, rescoreScenario } from "./benchmark.mjs"
import { appendDecision, appendTurn, sessionHash } from "../src/state.js"

const SUITE = { turns: 3, tokensAt: (turn) => 1000 * turn }

test("rescoring replays fixed choices at another cache assumption", () => {
  const choices = ["deepseek/deepseek-flash", "deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]
  // turn 1: cold flash 1000 in + 800 out = 0.0002 + 0.00064
  // turn 2: flash again, 800 of 2000 cached at 0.05/M = 0.00004 + 0.00024 + 0.00064
  // turn 3: cold pro 3000 in + 800 out = 0.006 + 0.0064
  const row = rescoreScenario({
    name: "balanced",
    choices,
    suite: SUITE,
    cacheHitRatio: 0.8,
    switches: 1,
  })
  expect(row.cost).toBeCloseTo(0.01416, 6)
  expect(row.switches).toBe(1)
  expect(row.fixedDecisions).toBe(true)

  // At 50% only the second turn's cache share changes.
  const lower = rescoreScenario({ name: "balanced", choices, suite: SUITE, cacheHitRatio: 0.5, switches: 1 })
  expect(lower.cost).toBeCloseTo(0.014205, 6)
})

test("judge latency is measured from decisions and turns", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-bench-"))
  const env = { OMLX_ROUTER_STATE: path.join(dir, "state") }
  const hash = sessionHash("ses_1")
  appendTurn("opencode", { ts: 1, session: hash, judgeMs: 100 }, env)
  appendTurn("opencode", { ts: 2, session: hash, judgeMs: 300 }, env)
  appendTurn("opencode", { ts: 3, session: hash, judgeMs: 0 }, env)
  appendDecision("opencode", { ts: 1, judge: { used: true, cached: false } }, env)
  appendDecision("opencode", { ts: 2, judge: { used: true, cached: true } }, env)
  appendDecision("opencode", { ts: 3, judge: { used: false } }, env)
  appendDecision("opencode", { ts: 4, judge: { used: false } }, env)

  const stats = measuredJudgeLatency(env)
  expect(stats.turns).toBe(3)
  expect(stats.consultedTurns).toBe(2)
  expect(stats.consultedShare).toBeCloseTo(0.5, 6)
  expect(stats.cachedTurns).toBe(1)
  expect(stats.meanMs).toBe(200)
  expect(stats.p95Ms).toBe(300)
  expect(stats.judgeModel).toBe("auto")
})

test("judge latency is null without usage", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-bench-"))
  expect(measuredJudgeLatency({ OMLX_ROUTER_STATE: path.join(dir, "state") })).toBeNull()
})
