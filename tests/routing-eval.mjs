#!/usr/bin/env bun
/**
 * Routing-quality eval for the real judge.
 *
 * For each case we compare:
 *   1. the model chosen with the actual small-judge verdict, and
 *   2. the model chosen with a ground-truth verdict through the same scorer.
 *
 * The oracle is the cheapest model the configured policy considers adequate if
 * the judge were perfect. This answers whether the small judge is good enough
 * for optimisation, not just whether its labels look plausible.
 *
 * Usage:
 *   bun tests/routing-eval.mjs
 *   bun tests/routing-eval.mjs --model Qwen3-4B-Instruct-2507-4bit --runs 3
 *   bun tests/routing-eval.mjs --json
 */

import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js"
import { Judge } from "../src/judge.js"
import { loadCore } from "../src/wasm.js"
import { FLASH, PRO } from "./e2e/scenarios.mjs"

function parseArgs(argv) {
  const options = { model: "auto", baseURL: "http://127.0.0.1:1234/v1", timeoutMs: 15000, runs: 1, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--json") options.json = true
    else if (arg === "--model" || arg.startsWith("--model=")) {
      options.model = arg.includes("=") ? arg.split("=")[1] : argv[++index]
    } else if (arg === "--base-url" || arg.startsWith("--base-url=")) {
      options.baseURL = arg.includes("=") ? arg.split("=")[1] : argv[++index]
    } else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      options.timeoutMs = Number(arg.includes("=") ? arg.split("=")[1] : argv[++index])
    } else if (arg === "--runs" || arg.startsWith("--runs=")) {
      options.runs = Math.max(1, Number(arg.includes("=") ? arg.split("=")[1] : argv[++index]))
    } else if (arg === "--help" || arg === "-h") {
      options.help = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
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
    lastContextTokens: 90000,
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
]

function pool() {
  return [
    {
      providerID: "deepseek",
      modelID: "deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      variant: "high",
      local: false,
      cost: [{ input: 0.2, output: 0.8, cache: { read: 0.05, write: 0.2 } }],
      limit: { context: 262144, output: 131072 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      reasoning: true,
      status: "active",
    },
    {
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
    },
  ]
}

function request(core, settings, testCase, verdict, promptTokens) {
  return core.route({
    abi: 1,
    nowMs: Date.now(),
    host: "opencode",
    kind: "primary",
    role: "root",
    session: {
      hash: "routing-eval",
      agentID: "build",
      currentModel: { providerID: "deepseek", id: "deepseek-flash", variant: "high" },
    },
    turn: {
      promptText: testCase.prompt,
      promptTokens,
      images: 0,
      lastContextTokens: testCase.lastContextTokens ?? 0,
      toolFailures: 0,
    },
    pool: pool(),
    settings,
    pin: null,
    judge: { verdict, cached: false, unavailable: false },
    stats: { decisions: 0, switches: 0 },
  })
}

function decision(result) {
  const chosen = result.decision
    ? `${result.decision.providerID}/${result.decision.id}`
    : null
  const top = Array.isArray(result.decision?.top) ? result.decision.top : []
  const entry = top.find((candidate) => `${candidate.providerID}/${candidate.id}` === chosen)
  return {
    chosen,
    cost: Number(entry?.costUsd) || 0,
    verdict: result.log?.verdict ?? null,
  }
}

function compare(actual, oracle) {
  if (!actual.chosen || !oracle.chosen) return { match: false, under: false, over: false, regret: null }
  const match = actual.chosen === oracle.chosen
  const under = actual.chosen === "deepseek/deepseek-flash" && oracle.chosen === "deepseek/deepseek-v4-pro"
  const over = actual.chosen === "deepseek/deepseek-v4-pro" && oracle.chosen === "deepseek/deepseek-flash"
  const regret =
    oracle.cost > 0 ? Math.round(((actual.cost - oracle.cost) / oracle.cost) * 1000) / 10 : 0
  return { match, under, over, regret }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log("Usage: bun tests/routing-eval.mjs [--model <id>] [--runs n] [--json]")
    return 0
  }

  const settings = mergeConfig(DEFAULT_CONFIG, {
    policy: "cost",
    judge: { enabled: true, model: options.model, baseURL: options.baseURL, timeoutMs: options.timeoutMs },
    pool: {
      source: "list",
      models: [FLASH, PRO],
      minContext: 32000,
    },
    quality: { overrides: { [FLASH]: 0.55, [PRO]: 0.8 } },
  })
  const judge = new Judge({ config: settings.judge })
  const core = await loadCore()
  let selected
  try {
    selected = await judge.pickModel()
  } catch (error) {
    console.error(`judge unavailable: ${error.message}`)
    return 1
  }

  const rows = []
  for (const testCase of CASES) {
    const attempts = []
    for (let run = 0; run < options.runs; run += 1) {
      const need = request(core, settings, testCase, null)
      if (need.action !== "need_judge") {
        attempts.push({ error: `no judge request (${need.action})` })
        continue
      }
      const started = Date.now()
      try {
        const judged = await judge.verdict({ prompt: need.judgeRequest.prompt, cacheKey: null })
        const actual = decision(request(core, settings, testCase, judged.verdict))
        const oracle = decision(request(core, settings, testCase, testCase.truth))
        attempts.push({
          raw: judged.verdict,
          actual,
          oracle,
          compare: compare(actual, oracle),
          ms: judged.ms ?? Date.now() - started,
        })
      } catch (error) {
        attempts.push({ error: error.message })
      }
    }
    const good = attempts.filter((attempt) => !attempt.error)
    const first = good[0] ?? attempts[0]
    rows.push({
      id: testCase.id,
      attempts,
      raw: first.raw ?? null,
      actual: first.actual ?? null,
      oracle: first.oracle ?? null,
      compare: first.compare ?? null,
      ms: Math.round(good.reduce((total, attempt) => total + attempt.ms, 0) / Math.max(1, good.length)),
      matches: good.filter((attempt) => attempt.compare?.match).length,
      under: good.filter((attempt) => attempt.compare?.under).length,
      over: good.filter((attempt) => attempt.compare?.over).length,
      runs: good.length,
    })
  }

  if (options.json) {
    console.log(JSON.stringify({ selected, rows }, null, 2))
  } else {
    console.log(`judge model: ${selected} · policy cost · runs ${options.runs}`)
    console.log("")
    console.log("case                 judge verdict          effective        actual   oracle   match  cost Δ")
    for (const row of rows) {
      if (!row.actual) {
        console.log(`${row.id.padEnd(20)} ERROR ${row.attempts[0]?.error ?? "unknown"}`)
        continue
      }
      const raw = `${row.raw.task} c${row.raw.complexity} ${row.raw.reasoningNeed}`
      const effective = `${row.actual.verdict.task} c${row.actual.verdict.complexity} ${row.actual.verdict.reasoningNeed}`
      const actual = row.actual.chosen.replace("deepseek/", "")
      const oracle = row.oracle.chosen.replace("deepseek/", "")
      const regret = row.compare.regret == null ? "?" : `${row.compare.regret > 0 ? "+" : ""}${row.compare.regret}%`
      console.log(
        `${row.id.padEnd(20)} ${raw.padEnd(22)} ${effective.padEnd(16)} ${actual.padEnd(8)} ${oracle.padEnd(8)} ${row.compare.match ? "yes" : "NO"}     ${regret}`,
      )
    }
    const total = rows.reduce((sum, row) => sum + row.runs, 0)
    const matches = rows.reduce((sum, row) => sum + row.matches, 0)
    const under = rows.reduce((sum, row) => sum + row.under, 0)
    const over = rows.reduce((sum, row) => sum + row.over, 0)
    const regrets = rows
      .map((row) => row.compare?.regret)
      .filter((value) => value != null && Number.isFinite(value))
    const averageRegret = regrets.length ? Math.round((regrets.reduce((a, b) => a + b, 0) / regrets.length) * 10) / 10 : 0
    console.log("")
    console.log(
      `routing match ${matches}/${total} · under-routed ${under} · over-routed ${over} · mean cost delta ${averageRegret > 0 ? "+" : ""}${averageRegret}%`,
    )
  }

  const under = rows.reduce((sum, row) => sum + row.under, 0)
  return under === 0 ? 0 : 1
}

process.exit(await main())
