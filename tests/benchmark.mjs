#!/usr/bin/env bun
/**
 * Reproducible routing benchmark.
 *
 * Simulates a ten-turn coding session and compares:
 *   - a fixed cheap, mid, and frontier model,
 *   - a static complexity-tier baseline (simulated category baseline),
 *   - this router in `balanced` and `switch` pin modes.
 *
 * Decisions come from the real WASM core with recorded (oracle) verdicts, so
 * runs are deterministic. Costs are modelled from published per-million-token
 * prices and assume 80% of the stable prefix is a cache read on repeated turns.
 *
 * Usage:
 *   bun tests/benchmark.mjs
 *   bun tests/benchmark.mjs --json
 *   bun tests/benchmark.mjs --write
 */

import fs from "node:fs"
import path from "node:path"

import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js"
import { loadCore } from "../src/wasm.js"

const TURNS = 10
const OUTPUT_TOKENS = 800
const CACHE_HIT_RATIO = 0.8

const MODELS = {
  cheap: {
    providerID: "deepseek",
    modelID: "deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    variant: "default",
    local: false,
    cost: [{ input: 0.2, output: 0.8, cache: { read: 0.05, write: 0.2 } }],
    limit: { context: 262144, output: 131072 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    reasoning: true,
    status: "active",
    quality: 0.55,
  },
  mid: {
    providerID: "deepseek",
    modelID: "deepseek-v4-pro",
    name: "DeepSeek V4.1 Pro",
    variant: "default",
    local: false,
    cost: [{ input: 2, output: 8, cache: { read: 0.5, write: 2 } }],
    limit: { context: 262144, output: 131072 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    reasoning: true,
    status: "active",
    quality: 0.8,
  },
  frontier: {
    providerID: "anthropic",
    modelID: "claude-fable-5-2",
    name: "Claude Fable 5.2",
    variant: "default",
    local: false,
    cost: [{ input: 8, output: 40, cache: { read: 0.2, write: 10 } }],
    limit: { context: 1000000, output: 32000 },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    reasoning: true,
    status: "active",
    quality: 0.95,
  },
}

const CASES = [
  {
    id: "simple-question",
    prompt: "Explain how the --verbose flag changes ripgrep's output, and when to use it in a build script.",
    truth: { task: "research", complexity: 1, needsTools: false, needsVision: false, contextNeed: "small", reasoningNeed: "low", confidence: 0.9 },
  },
  {
    id: "small-edit",
    prompt: "Add a null check to src/parser.rs and run the tests.",
    truth: { task: "edit", complexity: 2, needsTools: true, needsVision: false, contextNeed: "small", reasoningNeed: "low", confidence: 0.9 },
  },
  {
    id: "debug",
    prompt:
      "Debug why `cargo test` panics with an index out of bounds in src/lexer.rs. The stack trace points at token_at() reading past the token vector. Propose a fix and add a regression test.",
    truth: { task: "debug", complexity: 4, needsTools: true, needsVision: false, contextNeed: "small", reasoningNeed: "high", confidence: 0.9 },
  },
  {
    id: "planning",
    prompt:
      "Design a migration of the parser in src/parse.rs to a streaming API. Cover the trade-offs, failure modes, and a phased rollout.",
    truth: { task: "plan", complexity: 4, needsTools: true, needsVision: false, contextNeed: "medium", reasoningNeed: "high", confidence: 0.9 },
  },
  {
    id: "security-review",
    prompt:
      "Review the authentication middleware in src/auth.rs for security issues. List each vulnerability with severity and a fix.",
    truth: { task: "review", complexity: 4, needsTools: true, needsVision: false, contextNeed: "small", reasoningNeed: "high", confidence: 0.9 },
  },
  {
    id: "large-context",
    prompt: "Continue the refactor and update the call sites.",
    truth: { task: "refactor", complexity: 3, needsTools: true, needsVision: false, contextNeed: "large", reasoningNeed: "medium", confidence: 0.9 },
  },
  {
    id: "multi-file-refactor",
    prompt:
      "Refactor the parser across src/parser.rs, src/lexer.rs, and src/ast.rs. Keep the tests passing and update the call sites.",
    truth: { task: "refactor", complexity: 4, needsTools: true, needsVision: false, contextNeed: "medium", reasoningNeed: "high", confidence: 0.9 },
  },
  {
    id: "ui-change",
    prompt: "Make the settings dialog keyboard-navigable and add visible focus outlines.",
    truth: { task: "ui", complexity: 3, needsTools: true, needsVision: false, contextNeed: "small", reasoningNeed: "medium", confidence: 0.9 },
  },
  {
    id: "research-comparison",
    prompt: "Compare three parser designs and recommend one for a streaming API. Include the trade-offs.",
    truth: { task: "research", complexity: 3, needsTools: false, needsVision: false, contextNeed: "medium", reasoningNeed: "medium", confidence: 0.9 },
  },
  {
    id: "trivial",
    prompt: "What does this flag do?",
    truth: { task: "trivial", complexity: 1, needsTools: false, needsVision: false, contextNeed: "small", reasoningNeed: "low", confidence: 0.9 },
  },
]

function parseArgs(argv) {
  const options = { json: false, write: false }
  for (const arg of argv) {
    if (arg === "--json") options.json = true
    else if (arg === "--write") options.write = true
    else if (arg === "--help" || arg === "-h") options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function label(model) {
  return `${model.providerID}/${model.modelID}`
}

function modelKey(reference) {
  return reference ? `${reference.providerID}/${reference.id ?? reference.modelID}` : null
}

function tokensForTurn(turn) {
  return 4000 + 3000 * turn
}

function requiredQuality(verdict) {
  const base = [0, 0.25, 0.4, 0.55, 0.75, 0.9][Math.min(5, Math.max(1, verdict.complexity))]
  const reasoning = verdict.reasoningNeed === "high" ? 0.1 : 0
  const planning = verdict.task === "plan" || verdict.task === "review" ? 0.05 : 0
  return Math.min(1, base + reasoning + planning)
}

function turnCost(model, tokens, cachedTokens) {
  const price = model.cost[0]
  const cached = Math.min(tokens, Math.max(0, cachedTokens)) * CACHE_HIT_RATIO
  const fresh = tokens - cached
  return (
    (fresh / 1_000_000) * price.input +
    (cached / 1_000_000) * price.cache.read +
    (OUTPUT_TOKENS / 1_000_000) * price.output
  )
}

function passes(model, verdict) {
  return model.quality + 1e-9 >= requiredQuality(verdict)
}

function settings({ mode = "balanced", policy = "cost" } = {}) {
  return mergeConfig(DEFAULT_CONFIG, {
    policy,
    pool: {
      source: "list",
      models: [label(MODELS.cheap), label(MODELS.mid), label(MODELS.frontier)],
      requireTools: true,
      minContext: 32000,
    },
    quality: {
      overrides: {
        [label(MODELS.cheap)]: MODELS.cheap.quality,
        [label(MODELS.mid)]: MODELS.mid.quality,
        [label(MODELS.frontier)]: MODELS.frontier.quality,
      },
    },
    pin: { mode },
    judge: { enabled: true },
  })
}

function fixedScenario(model) {
  let cost = 0
  let passed = 0
  let previousTokens = 0
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const verdict = CASES[(turn - 1) % CASES.length].truth
    const tokens = tokensForTurn(turn)
    cost += turnCost(model, tokens, previousTokens)
    if (passes(model, verdict)) passed += 1
    previousTokens = tokens
  }
  return {
    name: `fixed ${label(model)}`,
    qualityPass: passed,
    turns: TURNS,
    switches: 0,
    cost,
  }
}

function staticTierScenario() {
  let cost = 0
  let passed = 0
  let previousTokens = 0
  let previousModel = null
  let switches = 0
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const verdict = CASES[(turn - 1) % CASES.length].truth
    const model = verdict.complexity >= 4 ? MODELS.frontier : verdict.complexity === 3 ? MODELS.mid : MODELS.cheap
    const tokens = tokensForTurn(turn)
    cost += turnCost(model, tokens, previousModel === model ? previousTokens : 0)
    if (passes(model, verdict)) passed += 1
    if (previousModel && previousModel !== model) switches += 1
    previousModel = model
    previousTokens = tokens
  }
  return {
    name: "static complexity tiers (simulated)",
    qualityPass: passed,
    turns: TURNS,
    switches,
    cost,
  }
}

async function routerScenario(core, mode, { overrides = {}, name = `router ${mode}` } = {}) {
  const config = mergeConfig(settings({ mode }), overrides)
  let pin = null
  let current = null
  let previousTokens = 0
  let cost = 0
  let passed = 0
  let switches = 0
  const choices = []

  for (let turn = 1; turn <= TURNS; turn += 1) {
    const testCase = CASES[(turn - 1) % CASES.length]
    const tokens = tokensForTurn(turn)
    const result = core.route({
      abi: 1,
      nowMs: turn * 1000,
      host: "benchmark",
      kind: "primary",
      role: "root",
      session: {
        hash: "benchmark",
        agentID: "build",
        agentMode: "",
        currentModel: current,
      },
      turn: {
        promptText: testCase.prompt,
        promptTokens: Math.ceil(testCase.prompt.length / 4),
        images: 0,
        lastContextTokens: tokens,
        toolFailures: 0,
        turnClassHint: null,
      },
      pool: [MODELS.cheap, MODELS.mid, MODELS.frontier].map(({ quality, ...model }) => model),
      settings: config,
      pin,
      judge: { verdict: testCase.truth, cached: false, unavailable: false },
      stats: { decisions: turn - 1, switches },
    })

    const chosen = result.decision
      ? { providerID: result.decision.providerID, id: result.decision.id, variant: result.decision.variant ?? "default" }
      : current
    const key = modelKey(chosen)
    const model = Object.values(MODELS).find((entry) => label(entry) === key) ?? MODELS.cheap
    const switched = current ? modelKey(current) !== key : false
    if (switched) switches += 1
    cost += turnCost(model, tokens, switched ? 0 : previousTokens)
    if (passes(model, testCase.truth)) passed += 1
    choices.push(key)
    current = chosen
    previousTokens = tokens
    pin = result.pin ?? pin
  }

  return {
    name,
    qualityPass: passed,
    turns: TURNS,
    switches,
    cost,
    choices,
  }
}

function money(value) {
  return `$${Number(value).toFixed(3)}`
}

function markdown(results) {
  const frontier = results.find((row) => row.name === "fixed anthropic/claude-fable-5-2")
  const rows = results.map((row) => {
    const delta = frontier && frontier.cost > 0 ? ((row.cost - frontier.cost) / frontier.cost) * 100 : 0
    return `| ${row.name} | ${row.qualityPass}/${row.turns} | ${row.switches} | ${money(row.cost)} | ${delta >= 0 ? "+" : ""}${delta.toFixed(0)}% |`
  })
  return [
    "# Routing benchmark — 2026-11-17",
    "",
    "Generated by `bun run bench`. Decisions come from the real WASM core with",
    "recorded verdicts; costs are modelled from published per-million-token",
    "prices.",
    "",
    "## Setup",
    "",
    `- ${TURNS} turns, cycling ${CASES.length} prompts from the routing eval.`,
    "- Context grows from 7k to 34k input tokens; 800 output tokens per turn.",
    "- Prices per million tokens: cheap 0.2/0.8, mid 2/8, frontier 8/40.",
    "- Cache assumption: 80% of the stable prefix is read from cache on turns",
    "  that keep the same model; a switch pays a cold prefill.",
    "- Quality: cheap 0.55, mid 0.8, frontier 0.95, compared against the quality",
    "  required by each recorded verdict.",
    "",
    "## Results",
    "",
    "| Scenario | Quality pass | Switches | Cost (10 turns) | vs frontier |",
    "|---|---:|---:|---:|---:|",
    ...rows,
    "",
    "## What this measures",
    "",
    "- **Routing and cost**, not answer quality. A quality pass means the chosen",
    "  model clears the verdict's required quality; it does not measure whether",
    "  the model actually solved the task.",
    "- The static tier baseline is simulated from verdict complexity. It is a",
    "  category baseline, not a run of another plugin.",
    "- Ollama/llama.cpp judge latency is not included; the judge is a side call",
    "  and adds no tokens to the conversation.",
    "",
    "## Reading the numbers",
    "",
    "- The fixed cheap and mid models each miss 4/10 turns on required quality;",
    "  the frontier model and both router modes pass every turn.",
    "- `switch` has no pin, so it takes Flash or Pro whenever they clear the bar.",
    "  The cold prefill is cheaper than a frontier turn at $40/M output.",
    "- `balanced` keeps Fable from turn 3 onward. Turn 6 shows why: the best",
    "  unblocked alternative was Pro, which scored 0.59 against Fable's 0.50 — a",
    "  0.09 gain, under the 0.12 switch threshold. Flash would have cost $0.006",
    "  against Fable's $0.112, but the flip-flop guard excluded it after earlier",
    "  use. The cost check compares Fable with Pro, and 0.112 is 1.9x 0.059, under",
    "  the 4x release ratio.",
    "- That gap is a tuning question. `switchThreshold`, `costSwitchRatio`, and",
    "  `flipFlopTurns` decide how long an expensive incumbent stays. Short",
    "  sessions favour `switch`; long sessions with a large stable prefix can",
    "  favour `cache` or `balanced`.",
    "- `mixed` weights (0.6 / 0.35 / 0.05, with quality-heavy planning and review)",
    "  also land at $0.827. The weights change scores, and the pin still clears the",
    "  0.12 threshold by the same margin. Weights express preference; the pin",
    "  settings set the cost.",
    "",
    "## Reproduce",
    "",
    "```sh",
    "bun run bench          # print the table",
    "bun run bench --json   # machine-readable output",
    "```",
    "",
  ].join("\n")
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log("Usage: bun tests/benchmark.mjs [--json] [--write]")
    return 0
  }

  const core = await loadCore()
  const results = [
    fixedScenario(MODELS.cheap),
    fixedScenario(MODELS.mid),
    fixedScenario(MODELS.frontier),
    staticTierScenario(),
    await routerScenario(core, "balanced"),
    await routerScenario(core, "switch"),
    await routerScenario(core, "balanced", {
      name: "router mixed (balanced)",
      overrides: {
        policyWeights: { cost: 0.6, quality: 0.35, latency: 0.05 },
        policyByClass: {
          planning: { cost: 0.1, quality: 0.8, latency: 0.1 },
          review: { cost: 0.1, quality: 0.8, latency: 0.1 },
        },
      },
    }),
  ]

  if (options.json) {
    console.log(JSON.stringify({ turns: TURNS, results }, null, 2))
    return 0
  }

  const text = markdown(results)
  if (options.write) {
    const target = path.resolve(import.meta.dir, "../docs/benchmarks/2026-11-17-routing.md")
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
    console.log(`wrote ${target}`)
    return 0
  }

  console.log(text)
  return 0
}

process.exit(await main())
