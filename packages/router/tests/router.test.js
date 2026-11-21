import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { readConfig, saveConfig } from "@231self/opencode-shared/config.js"
import { writeJudgeNoise } from "../src/judge.js"
import { Router, cooldownFor, isFailoverError, isProviderWide } from "../src/router.js"
import { appendDecision, appendTurn, readDecisions, readPin, sessionHash, writePin } from "@231self/opencode-shared/state.js"

const MODELS = [
  {
    providerID: "deepseek",
    id: "deepseek-flash",
    name: "DeepSeek Flash",
    type: "chat",
    cost: [{ input: 0.2, output: 0.8, cache: { read: 0.05, write: 0.2 } }],
    limit: { context: 262144, output: 131072 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    status: "active",
  },
  {
    providerID: "deepseek",
    id: "deepseek-v4-pro",
    name: "DeepSeek Pro",
    type: "chat",
    cost: [{ input: 2, output: 8, cache: { read: 0.5, write: 2 } }],
    limit: { context: 262144, output: 131072 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    status: "active",
  },
]

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-router-"))
  const favorites = path.join(dir, "model.json")
  fs.writeFileSync(
    favorites,
    JSON.stringify({
      favorite: [
        { providerID: "deepseek", modelID: "deepseek-flash" },
        { providerID: "deepseek", modelID: "deepseek-v4-pro" },
      ],
      variant: {},
    }),
  )
  return {
    OMLX_ROUTER_CONFIG: path.join(dir, "config.json"),
    OMLX_ROUTER_STATE: path.join(dir, "state"),
    OMLX_ROUTER_FAVORITES: favorites,
  }
}

function decisionResponse(overrides = {}) {
  const model = { providerID: "deepseek", id: "deepseek-flash", variant: "default" }
  return {
    action: "decide",
    decision: {
      providerID: model.providerID,
      id: model.id,
      variant: model.variant,
      source: "judge",
      reason: "better-model",
      pinned: false,
      complexity: 2,
      turnClass: "agentic",
      confidence: 0.8,
      top: [],
      ...overrides,
    },
    pin: {
      model,
      since: 1,
      lastTurnAt: 2,
      lastTurnClass: "agentic",
      lastComplexity: 2,
      switchCount: 1,
      away: [],
      source: "judge",
      forced: false,
    },
    log: {
      ts: 1,
      host: "opencode",
      role: "root",
      agent: "build",
      session: "hash",
      kind: "primary",
      stage: "judge/cost",
      reason: "better-model",
      poolSize: 2,
      chosen: "deepseek/deepseek-flash",
      pinned: false,
      source: "judge",
      judge: { used: true, cached: false, confidence: 0.8 },
      top: [],
      applied: "same-turn",
      error: null,
      turnClass: "agentic",
      complexity: 2,
    },
    state: { decisions: 1, switches: 1 },
  }
}

function harness({ sessionModel, env, core } = {}) {
  const switches = []
  const ctx = {
    session: {
      get: async () => ({ id: "ses_1", agent: "build", model: sessionModel }),
      switchModel: async ({ model }) => switches.push(model),
    },
    agent: { get: async () => ({ id: "build", mode: "primary" }) },
    model: { list: async () => MODELS },
    provider: { list: async () => [] },
  }
  const judge = {
    configure() {},
    verdict: async () => ({
      verdict: {
        task: "edit",
        complexity: 2,
        needsTools: true,
        needsVision: false,
        contextNeed: "small",
        reasoningNeed: "medium",
        confidence: 0.8,
      },
      cached: false,
      ms: 4,
    }),
  }
  return {
    switches,
    router: new Router({ ctx, env, core, judge, host: "opencode" }),
  }
}

function downgradeHarness({ compact } = {}) {
  const env = tempEnv()
  const models = MODELS.map((model, index) => index === 0
    ? { ...model, limit: { context: 32_000, output: 8_192 } }
    : model)
  const large = { providerID: "deepseek", id: "deepseek-v4-pro", variant: "default" }
  const calls = []
  const { router, switches } = harness({
    env,
    sessionModel: large,
    core: {
      route(request) {
        calls.push(request.pool.map((model) => model.modelID))
        return request.pool.some((model) => model.modelID === "deepseek-flash")
          ? decisionResponse()
          : decisionResponse(large)
      },
    },
  })
  let messages = [{ type: "user", text: "x".repeat(120_000) }]
  let attempts = 0
  router.ctx.model.list = async () => models
  router.ctx.session.context = async () => {
    if (messages instanceof Error) throw messages
    return { data: messages }
  }
  router.ctx.session.compact = async () => {
    attempts++
    router.compaction({ sessionID: "ses_1" })
    await compact?.()
    return { id: "queued" }
  }
  return {
    router, switches, calls, env,
    prompt: (text = "continue") => router.prompt({ sessionID: "ses_1", prompt: { text } }),
    setMessages: (value) => { messages = value },
    attempts: () => attempts,
    checkpoint: (overrides = {}) => ({
      type: "compaction", status: "completed", id: "applied", summary: "Short summary",
      time: { created: readPin("opencode", "ses_1", env).downgradeCompaction.at + 1 },
      ...overrides,
    }),
  }
}

test("a queued downgrade waits for a completed checkpoint and remeasures on the next prompt", async () => {
  const fixture = downgradeHarness()
  await fixture.prompt()
  expect(fixture.calls.slice(0, 2)).toEqual([["deepseek-v4-pro"], ["deepseek-flash", "deepseek-v4-pro"]])
  expect(fixture.attempts()).toBe(1)
  expect(fixture.switches).toEqual([])

  fixture.setMessages([fixture.checkpoint({ status: "running" })])
  await fixture.prompt()
  expect(fixture.switches).toEqual([])

  fixture.setMessages([fixture.checkpoint({ time: { created: 1 } })])
  await fixture.prompt()
  expect(fixture.switches).toEqual([])

  fixture.setMessages([fixture.checkpoint(), { type: "assistant", content: [{ type: "text", text: "Retained turn" }] }])
  await fixture.prompt()
  expect(fixture.switches.map((model) => model.id)).toEqual(["deepseek-flash"])
  expect(fixture.attempts()).toBe(1)
})

test("a failed or insufficient compaction never permits a smaller window or loops", async () => {
  const fixture = downgradeHarness({ compact: () => { throw new Error("refused") } })
  await fixture.prompt()
  fixture.setMessages(new Error("cannot read active context"))
  await fixture.prompt()
  fixture.setMessages([fixture.checkpoint({ status: "failed" })])
  await fixture.prompt()
  fixture.setMessages([fixture.checkpoint({ summary: "x".repeat(92_000) })])
  await fixture.prompt()
  fixture.setMessages([fixture.checkpoint(), { type: "assistant", content: [{ type: "text", text: "x".repeat(92_000) }] }])
  await fixture.prompt()
  fixture.setMessages([fixture.checkpoint()])
  await fixture.prompt("x".repeat(92_000))
  expect(fixture.switches).toEqual([])
  expect(fixture.attempts()).toBe(1)
})

test("a smaller model is not selected when active context cannot be verified", async () => {
  const fixture = downgradeHarness()
  fixture.setMessages(new Error("context unavailable"))
  await fixture.prompt()
  expect(fixture.switches).toEqual([])
  expect(fixture.attempts()).toBe(0)
})

test("routes a turn, switches model, and persists pin and decision", async () => {
  const env = tempEnv()
  const calls = []
  const core = {
    route: (input) => {
      calls.push(structuredClone(input))
      return calls.length === 1
        ? { action: "need_judge", judgeRequest: { prompt: "p", cacheKey: "k" } }
        : decisionResponse()
    },
  }
  const { router, switches } = harness({
    sessionModel: { providerID: "opencode", id: "iceman-free", variant: "default" },
    env,
    core,
  })
  await router.prompt({ sessionID: "ses_1", prompt: { text: "implement the parser", files: [] } })

  expect(calls.length).toBe(2)
  expect(calls[1].judge.verdict.complexity).toBe(2)
  expect(switches).toEqual([{ providerID: "deepseek", id: "deepseek-flash", variant: "default" }])
  const pin = readPin("opencode", "ses_1", env)
  expect(pin.model.id).toBe("deepseek-flash")
  expect(pin.lastApplied.id).toBe("deepseek-flash")
  const decisions = readDecisions("opencode", 5, env)
  expect(decisions.length).toBe(1)
  expect(decisions[0].chosen).toBe("deepseek/deepseek-flash")
})

test("does not switch when the decision matches the current model", async () => {
  const env = tempEnv()
  const core = { route: () => decisionResponse() }
  const { router, switches } = harness({
    sessionModel: { providerID: "deepseek", id: "deepseek-flash", variant: "default" },
    env,
    core,
  })
  await router.prompt({ sessionID: "ses_1", prompt: { text: "continue", files: [] } })
  expect(switches).toEqual([])
})

test("retry blocks the failed model and queues the next candidate", () => {
  const env = tempEnv()
  appendDecision(
    "opencode",
    {
      ts: 1,
      session: "hash",
      chosen: "deepseek/deepseek-flash",
      top: [
        { providerID: "deepseek", id: "deepseek-flash", variant: "default", score: 0.9 },
        { providerID: "deepseek", id: "deepseek-v4-pro", variant: "default", score: 0.8 },
      ],
    },
    env,
  )
  const { router } = harness({ env })
  const event = {
    sessionID: "ses_1",
    model: { providerID: "deepseek", id: "deepseek-flash", variant: "default" },
    error: { type: "rate-limit", message: "429 too many requests", status: 429 },
    attempt: 2,
    decision: { retry: true, delay: 100 },
  }
  router.retry(event)

  const pin = readPin("opencode", "ses_1", env)
  expect(pin.blocked).toHaveLength(1)
  expect(pin.blocked[0].id).toBe("deepseek-flash")
  expect(pin.blocked[0].until).toBeGreaterThan(Date.now())
  expect(pin.redirect.to.id).toBe("deepseek-v4-pro")
  expect(pin.model).toBe(null)

  const next = {
    sessionID: "ses_1",
    kind: "primary",
    model: { providerID: "deepseek", id: "deepseek-flash", variant: "default" },
  }
  router.resolveModel(next)
  expect(next.model.id).toBe("deepseek-v4-pro")
  expect(readPin("opencode", "ses_1", env).redirect).toBe(null)
  expect(readDecisions("opencode", 1, env)[0].stage).toBe("failover/redirect")
})

test("failover recognises quota and billing failures", () => {
  expect(isFailoverError({ status: 402, message: "insufficient credits" })).toBe(true)
  expect(isFailoverError({ status: 429, type: "rate-limit" })).toBe(true)
  expect(isFailoverError({ status: 400, type: "provider.invalid-request" })).toBe(false)
  expect(isProviderWide({ status: 402 })).toBe(true)
  expect(isProviderWide({ status: 401 })).toBe(true)
  expect(isProviderWide({ status: 429, type: "rate-limit" })).toBe(false)
  expect(isProviderWide({ status: 429, message: "quota exceeded" })).toBe(true)
})

test("auth and billing cooldowns are short", () => {
  const config = { failover: { cooldownMs: 300_000, serverCooldownMs: 60_000, authCooldownMs: 300_000 } }
  expect(cooldownFor(config, { status: 402 })).toBe(300_000)
  expect(cooldownFor(config, { status: 401 })).toBe(300_000)
  expect(cooldownFor(config, { status: 429 })).toBe(300_000)
  expect(cooldownFor(config, { status: 500 })).toBe(60_000)
})

test("a billing failure blocks the provider and redirects to another one", () => {
  const env = tempEnv()
  appendDecision(
    "opencode",
    {
      ts: 1,
      session: "hash",
      chosen: "deepseek/deepseek-flash",
      top: [
        { providerID: "deepseek", id: "deepseek-flash", variant: "default", score: 0.9 },
        { providerID: "deepseek", id: "deepseek-v4-pro", variant: "default", score: 0.8 },
        { providerID: "openai", id: "gpt-6.1-sol", variant: "default", score: 0.7 },
      ],
    },
    env,
  )
  const { router } = harness({ env })
  router.retry({
    sessionID: "ses_1",
    model: { providerID: "deepseek", id: "deepseek-flash", variant: "default" },
    error: { status: 402, message: "insufficient credits" },
    attempt: 2,
    decision: { retry: false },
  })
  const pin = readPin("opencode", "ses_1", env)
  expect(pin.blocked[0].providerWide).toBe(true)
  expect(pin.redirect.to.providerID).toBe("openai")
  expect(pin.redirect.to.id).toBe("gpt-6.1-sol")
})

test("retry ignores 400-class request errors", () => {
  const env = tempEnv()
  const { router } = harness({ env })
  router.retry({
    sessionID: "ses_1",
    model: { providerID: "deepseek", id: "deepseek-flash", variant: "default" },
    error: { type: "provider.invalid-request", message: "bad request", status: 400 },
    attempt: 2,
    decision: { retry: false },
  })
  expect(readPin("opencode", "ses_1", env)?.blocked).toBeUndefined()
})

test("routing skips a blocked model", async () => {
  const env = tempEnv()
  writePin(
    "opencode",
    "ses_1",
    {
      blocked: [
        {
          providerID: "deepseek",
          id: "deepseek-flash",
          until: Date.now() + 60_000,
          reason: "429",
        },
      ],
    },
    env,
  )
  const calls = []
  const core = {
    route: (input) => {
      calls.push(structuredClone(input))
      return decisionResponse({
        providerID: "deepseek",
        id: "deepseek-v4-pro",
        chosen: "deepseek/deepseek-v4-pro",
      })
    },
  }
  const { router } = harness({ env, core })
  await router.prompt({ sessionID: "ses_1", prompt: { text: "continue the refactor", files: [] } })
  expect(calls[0].pool.map((model) => model.modelID)).toEqual(["deepseek-v4-pro"])
})

test("detects a user model override and forces the pin", async () => {
  const env = tempEnv()
  const calls = []
  const core = {
    route: (input) => {
      calls.push(structuredClone(input))
      return decisionResponse()
    },
  }
  const { router } = harness({
    sessionModel: { providerID: "deepseek", id: "deepseek-v4-pro", variant: "default" },
    env,
    core,
  })
  writePin(
    "opencode",
    "ses_1",
    {
      model: { providerID: "deepseek", id: "deepseek-flash", variant: "default" },
      lastApplied: { providerID: "opencode", id: "iceman-free", variant: "default" },
      lastContextTokens: 100,
    },
    env,
  )
  await router.prompt({ sessionID: "ses_1", prompt: { text: "continue", files: [] } })
  expect(calls[0].pin.forced).toBe(true)
  expect(calls[0].pin.model.id).toBe("deepseek-v4-pro")
})

test("repeated tool failures surface on the next turn", async () => {
  const env = tempEnv()
  const calls = []
  const core = {
    route: (input) => {
      calls.push(structuredClone(input))
      return decisionResponse()
    },
  }
  const { router } = harness({ env, sessionModel: null, core })
  for (let index = 0; index < 3; index += 1) {
    router.toolAfter({ sessionID: "ses_1", tool: "read", status: "error" })
  }
  await router.prompt({ sessionID: "ses_1", prompt: { text: "continue", files: [] } })
  expect(calls[0].turn.toolFailures).toBe(3)
  router.toolAfter({ sessionID: "ses_1", tool: "read", status: "completed" })
  await router.prompt({ sessionID: "ses_1", prompt: { text: "continue", files: [] } })
  expect(calls[1].turn.toolFailures).toBe(0)
})

test("compaction clears the pin", async () => {
  const env = tempEnv()
  const { router } = harness({ env, sessionModel: null, core: { route: () => decisionResponse() } })
  writePin("opencode", "ses_1", { model: { providerID: "deepseek", id: "deepseek-flash" } }, env)
  router.compaction({ sessionID: "ses_1" })
  expect(readPin("opencode", "ses_1", env)).toBeUndefined()
})

test("a rejected switch is recorded as not applied and keeps the old pin", async () => {
  const env = tempEnv()
  const core = { route: () => decisionResponse() }
  const switches = []
  const ctx = {
    session: {
      get: async () => ({ id: "ses_1", agent: "build", model: { providerID: "opencode", id: "iceman-free" } }),
      switchModel: async ({ model }) => {
        switches.push(model)
        throw new Error("host refused the model")
      },
    },
    agent: { get: async () => ({ id: "build", mode: "primary" }) },
    model: { list: async () => MODELS },
    provider: { list: async () => [] },
  }
  const router = new Router({ ctx, env, core, host: "opencode" })
  await router.prompt({ sessionID: "ses_1", prompt: { text: "implement it", files: [] } })
  const [decision] = readDecisions("opencode", 1, env)
  expect(switches).toHaveLength(1)
  expect(decision.applied).toBe("none")
  expect(decision.error).toContain("host refused")
  expect(readPin("opencode", "ses_1", env).lastApplied.id).toBe("iceman-free")
})

test("prompt write preserves context state written while routing", async () => {
  const env = tempEnv()
  const core = {
    route: () => {
      writePin("opencode", "ses_1", { lastContextTokens: 123 }, env)
      return decisionResponse()
    },
  }
  const { router } = harness({ env, sessionModel: null, core })
  await router.prompt({ sessionID: "ses_1", prompt: { text: "implement it", files: [] } })
  const pin = readPin("opencode", "ses_1", env)
  expect(pin.model.id).toBe("deepseek-flash")
  expect(pin.lastContextTokens).toBe(123)
})

test("no-pool decisions carry an actionable onboarding hint", async () => {
  const env = tempEnv()
  const core = {
    route: () => ({
      action: "skip",
      reason: "no_pool",
      log: {
        ts: Date.now(),
        host: "opencode",
        role: "root",
        agent: "build",
        session: "hash",
        kind: "primary",
        stage: "skip/no_pool",
        reason: "no_pool",
        poolSize: 0,
        chosen: null,
        pinned: false,
        source: "skip",
        judge: { used: false, cached: false, confidence: 0 },
        top: [],
        applied: "none",
        error: null,
        turnClass: "agentic",
        complexity: 2,
        policy: "cost",
      },
      state: { decisions: 0, switches: 0 },
    }),
  }
  const { router } = harness({ env, sessionModel: null, core })
  await router.prompt({ sessionID: "ses_1", prompt: { text: "implement it", files: [] } })
  const [decision] = readDecisions("opencode", 1, env)
  expect(decision.reason).toBe("no_pool")
  expect(decision.hint).toContain("/router pool")
})

test("the incumbent is priced with its measured cache share", async () => {
  const env = tempEnv()
  const requests = []
  const { router } = harness({
    env,
    core: {
      route(request) {
        requests.push(request)
        return decisionResponse()
      },
    },
  })
  const flash = { providerID: "deepseek", id: "deepseek-flash", variant: "default" }

  // A pin with nothing measurable keeps the configured assumption.
  writePin("opencode", "ses_1", { model: flash, forced: true, since: 1, lastTurnAt: 2 }, env)
  await router.prompt({ sessionID: "ses_1", prompt: { text: "hi" } })
  expect(requests.at(-1).settings.pin.cacheHitRatio).toBe(0.8)

  // The pinned model served the last turn: its measured share applies.
  appendTurn(
    "opencode",
    {
      ts: Date.now(),
      session: sessionHash("ses_1"),
      usedModel: "deepseek/deepseek-flash",
      tokens: { input: 200, output: 10, reasoning: 0, cache: { read: 600, write: 0 } },
    },
    env,
  )
  await router.prompt({ sessionID: "ses_1", prompt: { text: "again" } })
  expect(requests.at(-1).settings.pin.cacheHitRatio).toBeCloseTo(0.75, 6)

  // Another model served the last turn: this pin has earned no cache.
  appendTurn(
    "opencode",
    {
      ts: Date.now(),
      session: sessionHash("ses_1"),
      usedModel: "deepseek/deepseek-v4-pro",
      tokens: { input: 200, output: 10, reasoning: 0, cache: { read: 600, write: 0 } },
    },
    env,
  )
  await router.prompt({ sessionID: "ses_1", prompt: { text: "third" } })
  expect(requests.at(-1).settings.pin.cacheHitRatio).toBe(0)
})

test("a configured zero keeps the cache discount off", async () => {
  const env = tempEnv()
  const requests = []
  const { router } = harness({
    env,
    core: {
      route(request) {
        requests.push(request)
        return decisionResponse()
      },
    },
  })
  const config = readConfig({ env, write: true }).config
  saveConfig({ ...config, pin: { ...config.pin, cacheHitRatio: 0 } }, { env })
  const flash = { providerID: "deepseek", id: "deepseek-flash", variant: "default" }
  writePin("opencode", "ses_1", { model: flash, forced: true, since: 1, lastTurnAt: 2 }, env)
  appendTurn(
    "opencode",
    {
      ts: Date.now(),
      session: sessionHash("ses_1"),
      usedModel: "deepseek/deepseek-flash",
      tokens: { input: 200, output: 10, reasoning: 0, cache: { read: 600, write: 0 } },
    },
    env,
  )
  await router.prompt({ sessionID: "ses_1", prompt: { text: "hi" } })
  expect(requests.at(-1).settings.pin.cacheHitRatio).toBe(0)
})

test("the switch threshold floors at the calibrated judge noise band", async () => {
  const env = tempEnv()
  const requests = []
  const { router } = harness({
    env,
    core: {
      route(request) {
        requests.push(request)
        return decisionResponse()
      },
    },
  })

  // A band above the configured threshold widens the hysteresis.
  writeJudgeNoise(
    { band: 0.3, requested: "auto", baseURL: "http://127.0.0.1:1234/v1" },
    env,
  )
  await router.prompt({ sessionID: "ses_1", prompt: { text: "hi" } })
  expect(requests.at(-1).settings.pin.switchThreshold).toBeCloseTo(0.3, 6)

  // A band below it leaves the configured threshold alone.
  writeJudgeNoise(
    { band: 0.05, requested: "auto", baseURL: "http://127.0.0.1:1234/v1" },
    env,
  )
  await router.prompt({ sessionID: "ses_1", prompt: { text: "again" } })
  expect(requests.at(-1).settings.pin.switchThreshold).toBeCloseTo(0.12, 6)

  // A calibration for another judge model does not apply.
  writeJudgeNoise(
    { band: 0.3, requested: "other-judge", baseURL: "http://127.0.0.1:1234/v1" },
    env,
  )
  await router.prompt({ sessionID: "ses_1", prompt: { text: "third" } })
  expect(requests.at(-1).settings.pin.switchThreshold).toBeCloseTo(0.12, 6)
})
