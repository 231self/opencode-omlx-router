import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { readTurns, summariseTurns } from "../src/state.js"
import { Telemetry } from "../src/telemetry.js"

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-telemetry-"))
  return {
    OMLX_ROUTER_CONFIG: path.join(dir, "config.json"),
    OMLX_ROUTER_STATE: path.join(dir, "state"),
  }
}

function event(type, created, data) {
  return { type, created, data }
}

test("telemetry separates routing, judge, model, and tool time", () => {
  const env = tempEnv()
  const telemetry = new Telemetry({ host: "opencode", env })
  telemetry.notePrompt("ses_1", {
    at: 1000,
    routeMs: 50,
    judgeMs: 40,
    coreMs: 5,
    switchMs: 2,
    chosen: { providerID: "deepseek", id: "deepseek-flash" },
    role: "root",
    agent: "build",
  })

  telemetry.handle(event("session.execution.started", 1050, { sessionID: "ses_1" }))
  telemetry.handle(
    event("session.step.started", 1050, {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      agent: "build",
      model: { providerID: "deepseek", id: "deepseek-flash" },
      started: 1050,
    }),
  )
  telemetry.handle(event("session.step.first-token", 1150, { sessionID: "ses_1", assistantMessageID: "msg_1" }))
  telemetry.handle(
    event("session.step.ended", 2100, {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      finish: "stop",
      cost: 0.001,
      tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 2, write: 3 } },
    }),
  )
  telemetry.handle(event("session.execution.succeeded", 3000, { sessionID: "ses_1" }))

  const [turn] = readTurns("opencode", 1, env)
  expect(turn.turnMs).toBe(2000)
  expect(turn.routeMs).toBe(50)
  expect(turn.judgeMs).toBe(40)
  expect(turn.coreMs).toBe(5)
  expect(turn.executionMs).toBe(1950)
  expect(turn.modelMs).toBe(1050)
  expect(turn.toolMs).toBe(900)
  expect(turn.ttftMs).toBe(100)
  expect(turn.steps).toBe(1)
  expect(turn.model).toBe("deepseek/deepseek-flash")
  expect(turn.usedModel).toBe("deepseek/deepseek-flash")
  expect(turn.finish).toBe("stop")
  expect(turn.cost).toBe(0.001)
  expect(turn.tokens).toEqual({ input: 10, output: 20, reasoning: 5, cache: { read: 2, write: 3 } })
})

test("failed executions still record turn timing", () => {
  const env = tempEnv()
  const telemetry = new Telemetry({ host: "opencode", env })
  telemetry.notePrompt("ses_2", { at: 1000, routeMs: 20, judgeMs: 10, chosen: "deepseek/deepseek-flash" })
  telemetry.handle(event("session.execution.started", 1020, { sessionID: "ses_2" }))
  telemetry.handle(
    event("session.step.started", 1020, {
      sessionID: "ses_2",
      assistantMessageID: "msg_2",
      model: { providerID: "deepseek", id: "deepseek-flash" },
      started: 1020,
    }),
  )
  telemetry.handle(event("session.execution.failed", 2020, { sessionID: "ses_2", error: { message: "boom" } }))

  const [turn] = readTurns("opencode", 1, env)
  expect(turn.finish).toBe("error")
  expect(turn.turnMs).toBe(1020)
  expect(turn.modelMs).toBe(1000)
  expect(turn.toolMs).toBe(0)
})

test("events without a session are ignored", () => {
  const env = tempEnv()
  const telemetry = new Telemetry({ host: "opencode", env })
  telemetry.handle(event("session.execution.started", 1000, {}))
  telemetry.handle(event("session.step.started", 1000, { model: { providerID: "x", id: "y" } }))
  expect(readTurns("opencode", 10, env)).toEqual([])
})

test("summariseTurns reports averages and shares", () => {
  const summary = summariseTurns(
    [
      { turnMs: 10_000, routeMs: 1_000, judgeMs: 800, modelMs: 7_000, toolMs: 2_000 },
      { turnMs: 20_000, routeMs: 2_000, judgeMs: 1_000, modelMs: 15_000, toolMs: 3_000 },
    ],
    20,
  )
  expect(summary.count).toBe(2)
  expect(summary.averages.turnMs).toBe(15_000)
  expect(summary.averages.judgeMs).toBe(900)
  expect(summary.averages.modelMs).toBe(11_000)
  expect(summary.shares.model).toBeCloseTo(0.733, 2)
  expect(summary.shares.judge).toBeCloseTo(0.06, 2)
  expect(summary.p50.turnMs).toBe(15_000)
  expect(summary.max.toolMs).toBe(3_000)
})

test("malformed or unknown events never throw", () => {
  const env = tempEnv()
  const telemetry = new Telemetry({ host: "opencode", env })
  expect(() => {
    telemetry.handle(null)
    telemetry.handle({ type: "unknown", created: 1000, data: { sessionID: "ses_x" } })
    telemetry.handle({ type: "session.step.started", created: "bad", data: { sessionID: "ses_x" } })
    telemetry.handle({ type: "session.execution.succeeded", created: "bad", data: { sessionID: "ses_x" } })
  }).not.toThrow()
  expect(readTurns("opencode", 10, env)).toEqual([])
})
