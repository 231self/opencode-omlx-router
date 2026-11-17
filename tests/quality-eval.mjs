#!/usr/bin/env bun
/**
 * Live answer-quality eval.
 *
 * Runs eight small, verifiable coding tasks through OpenCode with fixed
 * models, then grades each run with a deterministic check. No LLM judge.
 *
 * This spends provider tokens. It is opt-in and never runs in CI.
 *
 * Usage:
 *   bun tests/quality-eval.mjs
 *   bun tests/quality-eval.mjs --models deepseek/deepseek-flash,openai/gpt-6.1-sol
 *   bun tests/quality-eval.mjs --only fix-sum --keep
 *   bun tests/quality-eval.mjs --write
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const TASKS_DIR = path.resolve(import.meta.dir, "quality/tasks")
const DOCS_DIR = path.resolve(import.meta.dir, "../docs/benchmarks")
const LOG_DIR = path.join(os.tmpdir(), "omlx-qeval-logs")
const DEFAULT_MODELS = [
  "deepseek/deepseek-flash",
  "deepseek/deepseek-v4-pro",
  "openai/gpt-6.1-sol",
]

function parseArgs(argv) {
  const options = {
    models: DEFAULT_MODELS,
    only: null,
    json: false,
    write: false,
    keep: false,
    attempts: 1,
    timeoutMs: 180_000,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--models" || arg.startsWith("--models=")) {
      const value = arg.includes("=") ? arg.split("=")[1] : argv[++index]
      options.models = String(value)
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    } else if (arg === "--only" || arg.startsWith("--only=")) {
      options.only = arg.includes("=") ? arg.split("=")[1] : argv[++index]
    } else if (arg === "--attempts" || arg.startsWith("--attempts=")) {
      options.attempts = Math.max(1, Number(arg.includes("=") ? arg.split("=")[1] : argv[++index]) || 1)
    } else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      options.timeoutMs = Number(arg.includes("=") ? arg.split("=")[1] : argv[++index])
    } else if (arg === "--json") options.json = true
    else if (arg === "--write") options.write = true
    else if (arg === "--keep") options.keep = true
    else if (arg === "--help" || arg === "-h") options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function tasks() {
  return fs
    .readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(TASKS_DIR, name, "prompt.txt")))
    .sort()
}

function prepare(task) {
  const source = path.join(TASKS_DIR, task, "repo")
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `omlx-qeval-${task}-`))
  fs.cpSync(source, runDir, { recursive: true })
  const configPath = path.join(runDir, "opencode.json")
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          // Keep fixed-model runs fixed: the router must not switch the model.
          plugins: ["-omlx-router"],
          permissions: [
            { action: "*", resource: "*", effect: "allow" },
            // Eval prompts are tasks, not feature requests. Keep skills from
            // turning them into design conversations.
            { action: "skill", resource: "*", effect: "deny" },
          ],
        },
        null,
        2,
      ),
    )
  }
  return runDir
}

function runModel({ model, prompt, runDir, timeoutMs }) {
  const started = Date.now()
  const result = spawnSync("opencode", ["run", "--standalone", "--model", model, prompt], {
    cwd: runDir,
    // OpenCode resolves the location from PWD; spawnSync does not update it.
    env: { ...process.env, PWD: runDir },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  })
  const timedOut = result.signal === "SIGTERM" || result.error?.code === "ETIMEDOUT"
  return {
    ms: Date.now() - started,
    ok: result.status === 0,
    timedOut,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: (result.stderr ?? "").trim().split("\n").slice(-2).join(" "),
  }
}

function verify({ task, runDir }) {
  const result = spawnSync(process.execPath, [path.join(TASKS_DIR, task, "verify.mjs"), runDir], {
    cwd: runDir,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 5 * 1024 * 1024,
  })
  return {
    pass: result.status === 0,
    detail: result.status === 0 ? "" : (result.stderr ?? "").trim().split("\n").slice(-2).join(" "),
  }
}

function shortModel(model) {
  return model.split("/").pop()
}

function table(rows, models, list) {
  const width = Math.max(4, ...list.map((task) => task.length))
  const header = `${"task".padEnd(width)}  ${models.map((model) => shortModel(model).padEnd(14)).join(" ")}`
  const lines = [header]
  for (const task of list) {
    const cells = models.map((model) => {
      const subset = rows.filter((entry) => entry.task === task && entry.model === model)
      const passed = subset.filter((entry) => entry.pass).length
      return `${passed}/${subset.length}`.padEnd(14)
    })
    lines.push(`${task.padEnd(width)}  ${cells.join(" ")}`)
  }
  lines.push("")
  for (const model of models) {
    const attempts = rows.filter((entry) => entry.model === model)
    const passedTasks = list.filter((task) =>
      rows.some((entry) => entry.task === task && entry.model === model && entry.pass),
    ).length
    const passedAttempts = attempts.filter((entry) => entry.pass).length
    lines.push(
      `${shortModel(model)}: ${passedTasks}/${list.length} tasks (${passedAttempts}/${attempts.length} attempts)`,
    )
  }
  return lines.join("\n")
}

function markdown(rows, models, list) {
  const attempts = rows.filter((entry) => entry.task === list[0] && entry.model === models[0]).length
  const head = `| Task | ${models.map(shortModel).join(" | ")} |`
  const sep = `|---|${models.map(() => "---:").join("|")}|`
  const body = list.map((task) => {
    const cells = models.map((model) => {
      const subset = rows.filter((entry) => entry.task === task && entry.model === model)
      return `${subset.filter((entry) => entry.pass).length}/${subset.length}`
    })
    return `| ${task} | ${cells.join(" | ")} |`
  })
  const totals = models.map((model) => {
    const attempts = rows.filter((entry) => entry.model === model)
    const passedTasks = list.filter((task) =>
      rows.some((entry) => entry.task === task && entry.model === model && entry.pass),
    ).length
    return `| ${shortModel(model)} | ${passedTasks}/${list.length} (${attempts.filter((entry) => entry.pass).length}/${attempts.length} attempts) |`
  })
  return [
    "# Live answer-quality eval — 2026-11-17",
    "",
    "Eight small coding tasks, run through OpenCode with fixed models and graded",
    "by deterministic checks (`bun run quality:eval`). No LLM judge.",
    "",
    `## Results (pass@${attempts})`,
    "",
    head,
    sep,
    ...body,
    "",
    "| Model | Tasks passed |",
    "|---|---:|",
    ...totals,
    "",
    "## Method",
    "",
    "- Each task starts from a clean copy of `tests/quality/tasks/<id>/repo`.",
    "- Run: `opencode run --standalone --model <model> <prompt>` in that copy.",
    `- Each task and model runs ${attempts} time(s); a task passes when any attempt passes.`,
    "- The router is disabled for these runs so the selected model is the only",
    "  variable.",
    "- Grading: `node verify.mjs <run-dir>`; the model never sees the verifier.",
    "- Timeout: 180 s per run.",
    "",
    "## Caveats",
    "",
    "- Eight single-turn tasks; no long refactor or multi-turn session.",
    "- Passing checks measure task success, not code style or review quality.",
    "- Token cost is not recorded. Models were deepseek-flash, deepseek-v4-pro,",
    "  and openai/gpt-6.1-sol (roughly $0.5 per full matrix).",
    "- The router's live pass rate is not measured here. Map its recorded model",
    "  choices onto these per-model pass rates first.",
    "",
    "## Reproduce",
    "",
    "```sh",
    "bun run quality:eval",
    "bun run quality:eval --models deepseek/deepseek-flash",
    "```",
    "",
  ].join("\n")
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(
      "Usage: bun tests/quality-eval.mjs [--models a,b] [--only task] [--attempts n] [--json] [--write] [--keep] [--timeout ms]",
    )
    return 0
  }

  const list = tasks().filter((task) => !options.only || task === options.only)
  if (list.length === 0) throw new Error("no tasks selected")
  const rows = []

  for (const task of list) {
    const prompt = fs.readFileSync(path.join(TASKS_DIR, task, "prompt.txt"), "utf8").trim()
    for (const model of options.models) {
      for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
        const runDir = prepare(task)
        const run = runModel({ model, prompt, runDir, timeoutMs: options.timeoutMs })
        const check = verify({ task, runDir })
        fs.mkdirSync(LOG_DIR, { recursive: true })
        const logPath = path.join(
          LOG_DIR,
          `${task}-${shortModel(model)}-${attempt}.log`,
        )
        fs.writeFileSync(logPath, `${run.stdout}\n--- stderr ---\n${run.stderr}`)
        rows.push({
          task,
          model,
          attempt,
          pass: check.pass,
          ms: run.ms,
          runOk: run.ok,
          timedOut: run.timedOut,
          detail: check.detail || run.error,
        })
        const state = check.pass ? "pass" : "FAIL"
        const suffix = options.attempts > 1 ? ` #${attempt}` : ""
        console.log(
          `${task.padEnd(18)} ${shortModel(model).padEnd(18)}${suffix.padEnd(4)} ${state}  ${Math.round(run.ms / 1000)}s`,
        )
        if (check.pass && !options.keep) fs.rmSync(runDir, { recursive: true, force: true })
        else if (!check.pass) console.log(`  log ${logPath}`)
        if (!options.keep && !check.pass) fs.rmSync(runDir, { recursive: true, force: true })
        else if (options.keep) console.log(`  kept ${runDir}`)
      }
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ models: options.models, rows }, null, 2))
    return 0
  }

  console.log("")
  console.log(table(rows, options.models, list))

  if (options.write) {
    const target = path.join(DOCS_DIR, "2026-11-17-quality.md")
    fs.mkdirSync(DOCS_DIR, { recursive: true })
    fs.writeFileSync(target, markdown(rows, options.models, list))
    console.log(`\nwrote ${target}`)
  }
  return 0
}

process.exit(await main())
