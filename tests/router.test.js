import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Router } from "../src/router.js"
import { readDecisions, readPin, writePin } from "../src/state.js"

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

test("context hook stores the token estimate", async () => {
  const env = tempEnv()
  const { router } = harness({ env, sessionModel: null, core: { route: () => decisionResponse() } })
  await router.context({
    sessionID: "ses_1",
    system: [{ type: "text", text: "system prompt" }],
    messages: [{ parts: [{ type: "text", text: "hello world" }] }],
  })
  expect(readPin("opencode", "ses_1", env).lastContextTokens).toBeGreaterThan(0)
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

test("context hook applies the optimiser plan and records the result", async () => {
  const env = tempEnv()
  const core = {
    route: () => decisionResponse(),
    optimise: () => ({
      plan: [{ message: 0, part: 0, action: "stub", placeholder: "[pruned]" }],
      stats: { beforeTokens: 9000, afterTokens: 20, partsPruned: 1, overflow: false },
    }),
  }
  const { router } = harness({ env, sessionModel: null, core })
  const messages = [{ info: { role: "assistant" }, parts: [{ type: "tool", tool: "read", state: { status: "completed", output: "huge output" } }] }]
  await router.context({
    sessionID: "ses_1",
    model: { providerID: "deepseek", id: "deepseek-flash", limit: { context: 100000, output: 8192 } },
    system: [],
    messages,
  })
  expect(messages[0].parts[0].state.output).toBe("[pruned]")
  const pin = readPin("opencode", "ses_1", env)
  expect(pin.lastContextTokens).toBe(20)
  expect(pin.lastOptimiser.overflow).toBe(false)
})

test("context overflow breaks the pin without pruning", async () => {
  const env = tempEnv()
  const core = {
    route: () => decisionResponse(),
    optimise: () => ({
      plan: [],
      stats: { beforeTokens: 500000, afterTokens: 500000, partsPruned: 0, overflow: true },
    }),
  }
  const { router } = harness({ env, sessionModel: null, core })
  writePin("opencode", "ses_1", { model: { providerID: "deepseek", id: "deepseek-flash" } }, env)
  const messages = [{ parts: [] }]
  await router.context({
    sessionID: "ses_1",
    model: { providerID: "deepseek", id: "deepseek-flash", limit: { context: 100000, output: 8192 } },
    system: [],
    messages,
  })
  const pin = readPin("opencode", "ses_1", env)
  expect(pin.model).toBeUndefined()
  expect(pin.lastContextTokens).toBe(500000)
})

test("context hook resolves catalog limits when the event model omits them", async () => {
  const env = tempEnv()
  const seen = []
  const core = {
    route: () => decisionResponse(),
    optimise: (input) => {
      seen.push(input.model)
      return { plan: [], stats: { beforeTokens: 900, afterTokens: 900, partsPruned: 0, overflow: false } }
    },
  }
  const { router } = harness({ env, sessionModel: null, core })
  writePin("opencode", "ses_1", { model: { providerID: "deepseek", id: "deepseek-flash" } }, env)
  await router.context({
    sessionID: "ses_1",
    model: { providerID: "deepseek", id: "deepseek-flash" },
    system: [],
    messages: [{ parts: [] }],
  })
  expect(seen[0].limit.context).toBe(262144)
  expect(readPin("opencode", "ses_1", env).model.id).toBe("deepseek-flash")
})

test("a context write cannot clobber a newer routing pin", async () => {
  const env = tempEnv()
  const core = {
    route: () => decisionResponse(),
    optimise: () => {
      // Simulate the prompt hook writing a new decision while the context hook
      // is measuring (the two hooks are asynchronous in the host).
      writePin("opencode", "ses_1", { model: { providerID: "deepseek", id: "deepseek-v4-pro", variant: "default" } }, env)
      return { plan: [], stats: { beforeTokens: 100, afterTokens: 100, partsPruned: 0, overflow: false } }
    },
  }
  const { router } = harness({ env, sessionModel: null, core })
  writePin("opencode", "ses_1", { model: { providerID: "deepseek", id: "deepseek-flash" } }, env)
  await router.context({
    sessionID: "ses_1",
    model: { providerID: "deepseek", id: "deepseek-flash", limit: { context: 262144, output: 8192 } },
    system: [],
    messages: [{ parts: [] }],
  })
  expect(readPin("opencode", "ses_1", env).model.id).toBe("deepseek-v4-pro")
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
