#!/usr/bin/env bun
/**
 * Judge calibration for the real oMLX model.
 *
 * This exercises the *actual* judge prompt produced by the WASM core and the
 * real oMLX server. It reports the verdict, confidence, and latency per case,
 * then applies broad sanity expectations. Use it with `--model` to compare two
 * judge models on the same prompts.
 *
 * Usage:
 *   bun tests/judge-calibration.mjs
 *   bun tests/judge-calibration.mjs --model Qwen3-4B-Instruct-2507-4bit
 *   bun tests/judge-calibration.mjs --json
 */

import { DEFAULT_CONFIG, mergeConfig } from "@231self/opencode-shared/config.js"
import { Judge, gapSpread, judgeNoisePath, verdictNoiseBand, writeJudgeNoise } from "../src/judge.js"
import { loadCore } from "../src/wasm.js"
import { FLASH, PRO } from "./e2e/scenarios.mjs"

function parseArgs(argv) {
  const options = { model: "auto", baseURL: "http://127.0.0.1:1234/v1", timeoutMs: 120000, repeat: 3, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--json") options.json = true
    else if (arg === "--model" || arg.startsWith("--model=")) {
      options.model = arg.includes("=") ? arg.split("=")[1] : argv[++index]
    } else if (arg === "--base-url" || arg.startsWith("--base-url=")) {
      options.baseURL = arg.includes("=") ? arg.split("=")[1] : argv[++index]
    } else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      options.timeoutMs = Number(arg.includes("=") ? arg.split("=")[1] : argv[++index])
    } else if (arg === "--repeat" || arg.startsWith("--repeat=")) {
      options.repeat = Math.max(2, Number(arg.includes("=") ? arg.split("=")[1] : argv[++index]) || 3)
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
    expect: { tasks: ["research", "edit"], minComplexity: 1, maxComplexity: 3, reasoning: ["low", "medium"] },
  },
  {
    id: "small-edit",
    prompt: "Add a null check to src/parser.rs and run the tests.",
    expect: { tasks: ["edit", "debug"], minComplexity: 2, maxComplexity: 4, reasoning: ["low", "medium"], tools: true },
  },
  {
    id: "debug-trace",
    prompt:
      "Debug why `cargo test` panics with an index out of bounds in src/lexer.rs. The stack trace points at token_at() reading past the token vector. Propose a fix and add a regression test.",
    expect: { tasks: ["debug", "edit"], minComplexity: 3, maxComplexity: 5, reasoning: ["medium", "high"], tools: true },
  },
  {
    id: "planning",
    prompt:
      "Design a migration of the parser in src/parse.rs to a streaming API. Cover the trade-offs, failure modes, and a phased rollout.",
    expect: { tasks: ["plan", "research", "refactor"], minComplexity: 3, maxComplexity: 5, reasoning: ["medium", "high"] },
  },
  {
    id: "review",
    prompt:
      "Review the authentication middleware in src/auth.rs for security issues. List each vulnerability with severity and a fix.",
    expect: { tasks: ["review", "debug"], minComplexity: 3, maxComplexity: 5, reasoning: ["medium", "high"] },
  },
  {
    id: "large-context",
    prompt: "Continue the refactor and update the call sites.",
    lastContextTokens: 90000,
    expect: { tasks: ["edit", "refactor", "debug"], minComplexity: 3, maxComplexity: 5, context: ["medium", "large"] },
  },
]

function pool() {
  return [
    {
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

function request(core, settings, testCase, verdict = null) {
  return core.route({
    abi: 1,
    nowMs: Date.now(),
    host: "opencode",
    kind: "primary",
    role: "root",
    session: { hash: "calibration", agentID: "build", currentModel: { providerID: "deepseek", id: "deepseek-flash" } },
    turn: {
      promptText: testCase.prompt,
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

function check(testCase, verdict) {
  const failures = []
  const expected = testCase.expect
  if (expected.tasks && !expected.tasks.includes(verdict.task)) {
    failures.push(`task ${verdict.task} not in ${expected.tasks.join("|")}`)
  }
  if (verdict.complexity < expected.minComplexity || verdict.complexity > expected.maxComplexity) {
    failures.push(`complexity ${verdict.complexity} outside ${expected.minComplexity}-${expected.maxComplexity}`)
  }
  if (expected.reasoning && !expected.reasoning.includes(verdict.reasoningNeed)) {
    failures.push(`reasoning ${verdict.reasoningNeed} not in ${expected.reasoning.join("|")}`)
  }
  if (expected.context && !expected.context.includes(verdict.contextNeed)) {
    failures.push(`context ${verdict.contextNeed} not in ${expected.context.join("|")}`)
  }
  if (expected.tools !== undefined && verdict.needsTools !== expected.tools) {
    failures.push(`needsTools ${verdict.needsTools}, expected ${expected.tools}`)
  }
  return failures
}

/** The incumbent-vs-challenger score gap the pin threshold compares. */
function gapOf(routed) {
  const top = routed.top ?? routed.log?.top ?? []
  const score = (id) => top.find((entry) => (entry.id ?? entry.modelID) === id)?.score
  const flash = Number(score("deepseek-flash"))
  const pro = Number(score("deepseek-v4-pro"))
  if (!Number.isFinite(flash) || !Number.isFinite(pro)) return null
  return pro - flash
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log("Usage: bun tests/judge-calibration.mjs [--model <id>] [--base-url <url>] [--timeout ms] [--repeat n] [--json]")
    return 0
  }

  const settings = mergeConfig(DEFAULT_CONFIG, {
    judge: { enabled: true, model: options.model, baseURL: options.baseURL, timeoutMs: options.timeoutMs },
    quality: { overrides: { [FLASH]: 0.55, [PRO]: 0.8 } },
  })
  const judge = new Judge({ config: settings.judge })
  const core = await loadCore()

  let selected = null
  try {
    selected = await judge.pickModel()
  } catch (error) {
    console.error(`judge unavailable: ${error.message}`)
    return 1
  }

  const rows = []
  for (const testCase of CASES) {
    const routed = request(core, settings, testCase)
    if (routed.action !== "need_judge") {
      rows.push({ id: testCase.id, skipped: routed.action, reason: routed.reason ?? routed.stage ?? "" })
      continue
    }
    for (let sample = 0; sample < options.repeat; sample += 1) {
      const started = Date.now()
      let judged
      try {
        judged = await judge.verdict({ prompt: routed.judgeRequest.prompt, cacheKey: null })
      } catch (error) {
        rows.push({ id: testCase.id, sample, error: error.message, ms: Date.now() - started })
        continue
      }
      const raw = judged.verdict
      const routedWithVerdict = request(core, settings, testCase, raw)
      const verdict = routedWithVerdict.log?.verdict ?? raw
      rows.push({
        id: testCase.id,
        sample,
        task: verdict.task,
        rawComplexity: raw.complexity,
        complexity: verdict.complexity,
        reasoning: verdict.reasoningNeed,
        context: verdict.contextNeed,
        tools: verdict.needsTools,
        confidence: verdict.confidence,
        ms: judged.ms ?? Date.now() - started,
        gap: gapOf(routedWithVerdict),
        failures: check(testCase, verdict),
      })
    }
  }

  // Re-judged verdicts move the incumbent-vs-challenger gap; the widest such
  // movement is the noise band the pin threshold must not sit inside.
  const byCase = CASES.map((testCase) => ({
    id: testCase.id,
    gaps: rows
      .filter((row) => row.id === testCase.id)
      .map((row) => row.gap)
      .filter((gap) => Number.isFinite(gap)),
  })).filter((entry) => entry.gaps.length > 0)
  const band = verdictNoiseBand(byCase.map((entry) => entry.gaps))
  const noise = {
    requested: options.model,
    selected,
    baseURL: options.baseURL,
    samples: options.repeat,
    cases: byCase.map((entry) => ({ id: entry.id, gaps: entry.gaps, spread: gapSpread(entry.gaps) })),
    band,
    measuredAt: Date.now(),
  }
  let saved = null
  try {
    writeJudgeNoise(noise)
    saved = judgeNoisePath()
  } catch {
    // Calibration stays useful even when the artifact cannot be stored.
  }

  if (options.json) {
    console.log(JSON.stringify({ selected, rows, noise }, null, 2))
  } else {
    console.log(`judge model: ${selected}`)
    console.log("")
    console.log("case             task      raw→eff  reasoning  context  tools  conf   ms     result")
    for (const row of rows) {
      if (row.skipped) {
        console.log(`${row.id.padEnd(16)} ${row.skipped}: ${row.reason}`)
        continue
      }
      if (row.error) {
        console.log(`${row.id.padEnd(16)} ERROR ${row.error} (${row.ms} ms)`)
        continue
      }
      const result = row.failures.length === 0 ? "ok" : row.failures.join("; ")
      console.log(
        `${row.id.padEnd(16)} ${String(row.task).padEnd(9)} ${`${row.rawComplexity}→${row.complexity}`.padEnd(7)} ${String(row.reasoning).padEnd(10)} ${String(row.context).padEnd(8)} ${String(row.tools).padEnd(5)} ${row.confidence.toFixed(2)}  ${String(row.ms).padEnd(6)} ${result}`,
      )
    }
    if (noise.cases.length > 0) {
      console.log("")
      console.log("noise (score-gap movement across re-judged verdicts)")
      for (const entry of noise.cases) {
        const gaps = entry.gaps.map((gap) => `${gap >= 0 ? "+" : ""}${gap.toFixed(3)}`).join(" ")
        console.log(`${entry.id.padEnd(16)} spread ${entry.spread.toFixed(3)}  (${gaps})`)
      }
      console.log(
        `band ${band.toFixed(3)} floors pin.switchThreshold (configured ${settings.pin.switchThreshold})`,
      )
      if (saved) console.log(`saved ${saved}`)
    }
  }

  const failed = rows.filter((row) => row.failures?.length > 0)
  return failed.length === 0 ? 0 : 1
}

process.exit(await main())
