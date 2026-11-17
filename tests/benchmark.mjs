#!/usr/bin/env bun
/**
 * Reproducible routing benchmark.
 *
 * Simulates a coding session and compares:
 *   - a fixed cheap, mid, and frontier model,
 *   - a static complexity-tier baseline (simulated category baseline),
 *   - this router in cache, balanced, switch, and mixed-weight modes.
 *
 * Decisions come from the real WASM core with recorded (oracle) verdicts, so
 * runs are deterministic. Costs are modelled from published per-million-token
 * prices and assume 80% of the stable prefix is a cache read on repeated turns.
 *
 * Usage:
 *   bun tests/benchmark.mjs
 *   bun tests/benchmark.mjs --long
 *   bun tests/benchmark.mjs --json
 *   bun tests/benchmark.mjs --write
 */

import fs from "node:fs"
import path from "node:path"

import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js"
import { loadCore } from "../src/wasm.js"

const OUTPUT_TOKENS = 800
const CACHE_HIT_RATIO = 0.8

const SUITES = {
  short: {
    name: "short",
    title: "Routing benchmark",
    file: "2026-11-17-routing.md",
    turns: 10,
    tokensAt: (turn) => 4000 + 3000 * turn,
  },
  long: {
    name: "long",
    title: "Long-session routing benchmark",
    file: "2026-11-17-routing-long.md",
    turns: 24,
    tokensAt: (turn) => 12500 + 8500 * (turn - 1),
  },
}

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
  {
    id: "error-trace",
    prompt: "panic: index out of bounds in src/lexer.rs. Find the faulty read and add a regression test.",
    truth: { task: "debug", complexity: 4, needsTools: true, needsVision: false, contextNeed: "small", reasoningNeed: "high", confidence: 0.9 },
  },
  {
    id: "docs",
    prompt: "Update the README install section for the new plugin command and check the links.",
    truth: { task: "edit", complexity: 2, needsTools: true, needsVision: false, contextNeed: "small", reasoningNeed: "low", confidence: 0.9 },
  },
]

function parseArgs(argv) {
  const options = { json: false, write: false, long: false }
  for (const arg of argv) {
    if (arg === "--json") options.json = true
    else if (arg === "--write") options.write = true
    else if (arg === "--long") options.long = true
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

function caseAt(suite, turn) {
  return CASES[(turn - 1) % CASES.length]
}

function fixedScenario(model, suite) {
  let cost = 0
  let passed = 0
  let previousTokens = 0
  for (let turn = 1; turn <= suite.turns; turn += 1) {
    const testCase = caseAt(suite, turn)
    const tokens = suite.tokensAt(turn)
    cost += turnCost(model, tokens, previousTokens)
    if (passes(model, testCase.truth)) passed += 1
    previousTokens = tokens
  }
  return {
    name: `fixed ${label(model)}`,
    qualityPass: passed,
    turns: suite.turns,
    switches: 0,
    cost,
  }
}

function staticTierScenario(suite) {
  let cost = 0
  let passed = 0
  let previousTokens = 0
  let previousModel = null
  let switches = 0
  for (let turn = 1; turn <= suite.turns; turn += 1) {
    const testCase = caseAt(suite, turn)
    const verdict = testCase.truth
    const model = verdict.complexity >= 4 ? MODELS.frontier : verdict.complexity === 3 ? MODELS.mid : MODELS.cheap
    const tokens = suite.tokensAt(turn)
    cost += turnCost(model, tokens, previousModel === model ? previousTokens : 0)
    if (passes(model, verdict)) passed += 1
    if (previousModel && previousModel !== model) switches += 1
    previousModel = model
    previousTokens = tokens
  }
  return {
    name: "static complexity tiers (simulated)",
    qualityPass: passed,
    turns: suite.turns,
    switches,
    cost,
  }
}

async function routerScenario(core, mode, { suite, overrides = {}, name = `router ${mode}` } = {}) {
  const config = mergeConfig(settings({ mode }), overrides)
  let pin = null
  let current = null
  let previousTokens = 0
  let cost = 0
  let passed = 0
  let switches = 0
  const choices = []

  for (let turn = 1; turn <= suite.turns; turn += 1) {
    const testCase = caseAt(suite, turn)
    const tokens = suite.tokensAt(turn)
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
    turns: suite.turns,
    switches,
    cost,
    choices,
  }
}

function money(value) {
  return `$${Number(value).toFixed(3)}`
}

function markdown(results, suite) {
  const byName = Object.fromEntries(results.map((row) => [row.name, row]))
  const frontier = byName["fixed anthropic/claude-fable-5-2"]
  const cheap = byName["fixed deepseek/deepseek-flash"]
  const mid = byName["fixed deepseek/deepseek-v4-pro"]
  const switchRow = byName["router switch"]
  const balanced = byName["router balanced"]
  const cache = byName["router cache"]
  const mixed = byName["router mixed (balanced)"]
  const first = suite.tokensAt(1)
  const last = suite.tokensAt(suite.turns)
  const delta = (row) => ((row.cost - frontier.cost) / frontier.cost) * 100
  const rows = results.map((row) => {
    const diff = delta(row)
    return `| ${row.name} | ${row.qualityPass}/${row.turns} | ${row.switches} | ${money(row.cost)} | ${diff >= 0 ? "+" : ""}${diff.toFixed(0)}% |`
  })
  const passage = (row) => `${row.qualityPass}/${row.turns}`

  const bullets = [
    `- Fixed cheap passes ${passage(cheap)} turns, fixed mid ${passage(mid)}, and`,
    `  fixed frontier ${passage(frontier)}.`,
    `- \`switch\` costs ${money(switchRow.cost)} (${delta(switchRow) >= 0 ? "+" : "−"}${Math.abs(delta(switchRow)).toFixed(0)}% vs frontier) at ${passage(switchRow)} quality.`,
    `- \`balanced\` costs ${money(balanced.cost)} at ${passage(balanced)} quality, with ${balanced.switches} switches.`,
    `- \`cache\` costs ${money(cache.cost)} at ${passage(cache)} quality, with ${cache.switches} switches.`,
    `- \`mixed\` costs ${money(mixed.cost)} at ${passage(mixed)} quality, with ${mixed.switches} switches.`,
    switchRow.cost > balanced.cost
      ? `- The pin wins at this context size: switch pays ${money(switchRow.cost - balanced.cost)} more than balanced. Several cold prefills at ${Math.round(first / 1000)}k–${Math.round(last / 1000)}k tokens cost more than keeping the incumbent cached.`
      : `- Switching wins at this context size: switch saves ${money(balanced.cost - switchRow.cost)} against balanced. The cold prefill is cheaper than the incumbent's output price.`,
  ]

  return [
    `# ${suite.title} — 2026-11-17`,
    "",
    "Generated by `bun run bench`" + (suite.name === "long" ? " `--long`" : "") + ".",
    "Decisions come from the real WASM core with recorded verdicts; costs are",
    "modelled from published per-million-token prices.",
    "",
    "## Setup",
    "",
    `- ${suite.turns} turns, cycling ${CASES.length} prompts from the routing eval.`,
    `- Context grows from ${Math.round(first / 1000)}k to ${Math.round(last / 1000)}k input tokens; ${OUTPUT_TOKENS} output tokens per turn.`,
    "- Prices per million tokens: cheap 0.2/0.8, mid 2/8, frontier 8/40.",
    "- Cache assumption: 80% of the stable prefix is read from cache on turns",
    "  that keep the same model; a switch pays a cold prefill.",
    "- Quality: cheap 0.55, mid 0.8, frontier 0.95, compared against the quality",
    "  required by each recorded verdict.",
    "",
    "## Results",
    "",
    "| Scenario | Quality pass | Switches | Cost | vs frontier |",
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
    "- Judge latency is not included; the judge is a side call and adds no tokens",
    "  to the conversation.",
    "",
    "## Reading the numbers",
    "",
    ...bullets,
    "",
    "## Reproduce",
    "",
    "```sh",
    suite.name === "long" ? "bun run bench:long" : "bun run bench",
    "```",
    "",
  ].join("\n")
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log("Usage: bun tests/benchmark.mjs [--long] [--json] [--write]")
    return 0
  }

  const suite = options.long ? SUITES.long : SUITES.short
  const core = await loadCore()
  const results = [
    fixedScenario(MODELS.cheap, suite),
    fixedScenario(MODELS.mid, suite),
    fixedScenario(MODELS.frontier, suite),
    staticTierScenario(suite),
    await routerScenario(core, "cache", { suite }),
    await routerScenario(core, "balanced", { suite }),
    await routerScenario(core, "switch", { suite }),
    await routerScenario(core, "balanced", {
      suite,
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
    console.log(JSON.stringify({ suite: suite.name, turns: suite.turns, results }, null, 2))
    return 0
  }

  const text = markdown(results, suite)
  if (options.write) {
    const target = path.resolve(import.meta.dir, `../docs/benchmarks/${suite.file}`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
    console.log(`wrote ${target}`)
    return 0
  }

  console.log(text)
  return 0
}

process.exit(await main())
