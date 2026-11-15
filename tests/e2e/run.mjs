#!/usr/bin/env bun
/**
 * Live prompt tests for opencode-omlx-router.
 *
 * Each scenario sends real prompts to OpenCode V2 or Kilo while a deterministic
 * oMLX-compatible judge stub answers the router's verdict request. The harness
 * then checks both the decision record and the model the host actually used.
 *
 * Usage:
 *   bun tests/e2e/run.mjs
 *   bun tests/e2e/run.mjs --only pin-holds,complexity-jump
 *   bun tests/e2e/run.mjs --host kilo
 *   bun tests/e2e/run.mjs --real-judge --only live-judge
 *   bun tests/e2e/run.mjs --keep
 */

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { mergeConfig } from "../../src/config.js"
import { BASE_CONFIG, FLASH, SCENARIOS } from "./scenarios.mjs"
import {
  buildArgs,
  exportSession,
  hostBinary,
  makeEnv,
  parseSessionIDs,
  runProcess,
  writeHostConfig,
} from "./lib/hosts.mjs"
import { startStubJudge } from "./lib/stub-judge.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "../..")

function parseArgs(argv) {
  const options = { only: null, host: null, keep: false, realJudge: false, list: false, packageRoot: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") {
      options.help = true
    } else if (arg === "--keep") {
      options.keep = true
    } else if (arg === "--real-judge" || arg === "--live") {
      options.realJudge = true
    } else if (arg === "--list") {
      options.list = true
    } else if (arg === "--package" || arg.startsWith("--package=")) {
      options.packageRoot = arg.includes("=") ? arg.split("=")[1] : argv[++index]
    } else if (arg === "--host" || arg.startsWith("--host=")) {
      options.host = arg.includes("=") ? arg.split("=")[1] : argv[++index]
    } else if (arg === "--only" || arg.startsWith("--only=")) {
      const value = arg.includes("=") ? arg.split("=")[1] : argv[++index]
      options.only = new Set(String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean))
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function usage() {
  return `Usage: bun tests/e2e/run.mjs [options]

  --only <ids>      comma-separated scenario ids
  --host <name>     only opencode or kilo scenarios
  --real-judge      include scenarios tagged liveOnly (needs oMLX)
  --keep            keep every scenario workspace
  --package <path>  use an installed package directory instead of this checkout
  --list            list scenarios
`
}

function modelID(reference) {
  if (!reference) return null
  return String(reference).split("#")[0]
}

function sessionHash(sessionID) {
  return crypto.createHash("sha256").update(String(sessionID)).digest("hex").slice(0, 12)
}

function refString(model) {
  if (!model || !model.id || !model.providerID) return null
  return `${model.providerID}/${model.id}`
}

function assistantRefs(summary) {
  return (summary.assistantModels ?? []).map(refString).filter(Boolean)
}

function readJsonLines(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
}

async function waitForLines(file, previous, expectedNew, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const records = readJsonLines(file)
    if (expectedNew === 0 || records.length > previous || Date.now() > deadline) return records
    await Bun.sleep(50)
  }
}

function tail(text, lines = 8) {
  const value = String(text ?? "").trim()
  if (!value) return ""
  return value.split("\n").slice(-lines).join("\n")
}

function assertEqual(failures, label, actual, expected) {
  if (expected !== undefined && expected !== null && actual !== expected) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

async function runScenario(scenario, { stub, root, keep, packageRoot }) {
  const host = scenario.host ?? "opencode"
  const bin = hostBinary(host)
  if (!Bun.which(bin)) throw new Error(`${bin} is not installed`)
  if (host === "opencode" && !Bun.which("opencode")) throw new Error("opencode is not installed")

  const work = path.join(root, `${host}-${scenario.id}`)
  const workspace = path.join(work, "workspace")
  const state = path.join(work, "state")
  const configPath = path.join(work, "config.json")
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(state, { recursive: true })

  const config = mergeConfig(BASE_CONFIG, scenario.config ?? {})
  if (!config.judge.baseURL) config.judge.baseURL = `${stub.url}/v1`
  if (!scenario.liveOnly) {
    config.judge.model = "stub-judge-4B"
  }
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const initialModel = scenario.model ?? FLASH
  writeHostConfig(host, workspace, packageRoot ?? REPO, initialModel)

  let favoritesPath = null
  if (Array.isArray(scenario.favorites)) {
    favoritesPath = path.join(work, "favorites.json")
    const favorite = scenario.favorites.map((reference) => {
      const [providerID, ...rest] = String(reference).split("/")
      return { providerID, modelID: rest.join("/") }
    })
    fs.writeFileSync(favoritesPath, `${JSON.stringify({ favorite, variant: {} }, null, 2)}\n`)
  }

  const env = makeEnv({ configPath, statePath: state, favoritesPath })
  const decisionsFile = path.join(state, host, "decisions.jsonl")
  const scenarioResult = { scenario, work, steps: [], ok: true, error: null }
  let rootSessionID = null

  for (let index = 0; index < scenario.steps.length; index += 1) {
    const step = scenario.steps[index]
    stub.set(step.judge)
    stub.reset()
    const before = readJsonLines(decisionsFile).length
    const stepStarted = Date.now()

    const args = buildArgs(host, {
      prompt: step.prompt,
      sessionID: rootSessionID,
      model: step.model,
      agent: step.agent,
      auto: step.auto,
      title: index === 0 ? `e2e-${scenario.id}` : undefined,
    })
    const result = await runProcess({
      cmd: [bin, ...args],
      cwd: workspace,
      env,
      timeoutMs: step.timeoutMs ?? 180000,
    })

    const expectedNew = step.expect?.decisions?.length ?? 0
    const all = await waitForLines(decisionsFile, before, expectedNew)
    const records = all.slice(before)
    const ids = parseSessionIDs(`${result.stdout}\n${result.stderr}`)
    const idByHash = new Map(ids.map((id) => [sessionHash(id), id]))
    const turnsFile = path.join(state, host, "turns.jsonl")
    const turnsBefore = readJsonLines(turnsFile).length
    const turnRecords =
      host === "opencode"
        ? (await waitForLines(turnsFile, turnsBefore, expectedNew || 1))
            .filter((turn) => idByHash.has(turn.session) && Number(turn.ts) >= stepStarted)
        : []

    // The first decision with role=root identifies the top-level session when
    // the host did not expose it in the event stream.
    if (!rootSessionID) {
      const rootRecord = records.find((record) => record.role === "root")
      rootSessionID = rootRecord ? idByHash.get(rootRecord.session) ?? ids[0] ?? null : ids[0] ?? null
    }

    const failures = []
    if (result.spawnError) failures.push(`could not spawn ${bin}`)
    if (result.timedOut) failures.push(`timed out after ${(step.timeoutMs ?? 180000) / 1000}s`)
    if (!result.spawnError && !result.timedOut && result.code !== 0) {
      failures.push(`${bin} exited ${result.code}`)
    }
    const expectedCalls = step.expect?.judgeCalls
    if (expectedCalls !== undefined && expectedCalls !== null && stub.calls !== expectedCalls) {
      failures.push(`judge calls: expected ${expectedCalls}, got ${stub.calls}`)
    }
    if (host === "opencode") {
      const rootTurn = turnRecords.find((turn) => turn.role === "root")
      if (!rootTurn) {
        failures.push("no turn timing record (telemetry)")
      } else {
        if (!(Number(rootTurn.executionMs) > 0)) failures.push(`turn executionMs ${rootTurn.executionMs}`)
        if (!(Number(rootTurn.modelMs) > 0)) failures.push(`turn modelMs ${rootTurn.modelMs}`)
        if (Number(rootTurn.turnMs) + 1 < Number(rootTurn.executionMs)) {
          failures.push(`turnMs ${rootTurn.turnMs} is shorter than executionMs ${rootTurn.executionMs}`)
        }
        if (Number(rootTurn.judgeMs) > Number(rootTurn.routeMs) + 100) {
          failures.push(`judgeMs ${rootTurn.judgeMs} exceeds routeMs ${rootTurn.routeMs}`)
        }
        const expectedTiming = step.expect?.timing
        if (expectedTiming?.judgeMaxMs && Number(rootTurn.judgeMs) > expectedTiming.judgeMaxMs) {
          failures.push(`judgeMs ${rootTurn.judgeMs} over ${expectedTiming.judgeMaxMs}`)
        }
        if (expectedTiming?.modelMinMs && Number(rootTurn.modelMs) < expectedTiming.modelMinMs) {
          failures.push(`modelMs ${rootTurn.modelMs} under ${expectedTiming.modelMinMs}`)
        }
      }
    }

    const expectedDecisions = step.expect?.decisions ?? []
    const unmatched = [...records]
    const details = []
    const exports = new Map()

    if (expectedDecisions.length === 0) {
      if (records.length > 0) {
        failures.push(`expected no decision records, got ${records.length}`)
      }
      const id = rootSessionID
      if (id && (step.expect?.assistantModel || step.expect?.sessionModel)) {
        try {
          const summary = await exportSession({ host, cwd: workspace, env, sessionID: id })
          exports.set(id, summary)
          const wantedAssistant = step.expect?.assistantModel
          if (wantedAssistant && !assistantRefs(summary).includes(modelID(wantedAssistant))) {
            failures.push(
              `assistant model: expected ${wantedAssistant}, harness saw ${assistantRefs(summary).join(", ") || "none"}`,
            )
          }
          const wantedSession = step.expect?.sessionModel
          if (wantedSession && refString(summary.sessionModel) !== modelID(wantedSession)) {
            failures.push(`session model: expected ${wantedSession}, got ${refString(summary.sessionModel) ?? "none"}`)
          }
          details.push({ session: id, export: summary })
        } catch (error) {
          failures.push(error.message)
        }
      }
    }

    for (const expected of expectedDecisions) {
      const matchIndex = unmatched.findIndex(
        (record) =>
          record.role === (expected.role ?? "root") &&
          (expected.agent === undefined || record.agent === expected.agent),
      )
      if (matchIndex === -1) {
        failures.push(
          `no ${expected.role ?? "root"}${expected.agent ? `/${expected.agent}` : ""} decision record (got ${records.map((record) => `${record.role}/${record.agent}`).join(", ") || "none"})`,
        )
        continue
      }
      const record = unmatched.splice(matchIndex, 1)[0]
      const chosen = modelID(record.chosen)
      assertEqual(failures, "chosen", chosen, expected.chosen)
      assertEqual(failures, "source", record.source, expected.source)
      assertEqual(failures, "reason", record.reason, expected.reason)
      assertEqual(failures, "pinned", record.pinned, expected.pinned)
      assertEqual(failures, "applied", record.applied, expected.applied)
      assertEqual(failures, "policy", record.policy, expected.policy)
      assertEqual(failures, "stage", record.stage, expected.stage)
      assertEqual(failures, "role", record.role, expected.role ?? "root")
      assertEqual(failures, "agent", record.agent, expected.agent)
      if (expected.complexity !== undefined) {
        assertEqual(failures, "complexity", record.complexity, expected.complexity)
      }
      if (expected.judgeUsed !== undefined) {
        assertEqual(failures, "judge.used", Boolean(record.judge?.used), expected.judgeUsed)
      }
      if (expected.verdict) {
        if (!record.verdict) {
          failures.push("decision is missing the effective verdict")
        } else {
          for (const key of ["task", "complexity", "needsTools", "reasoningNeed", "contextNeed"]) {
            if (expected.verdict[key] !== undefined) {
              assertEqual(failures, `verdict.${key}`, record.verdict[key], expected.verdict[key])
            }
          }
        }
      }

      const sessionID = idByHash.get(record.session) ?? (record.role === "root" ? rootSessionID : null)
      if (!sessionID) {
        failures.push(`cannot map session ${record.session} (${record.role}) back to a host session id`)
      } else if (expected.assistantModel || expected.assistantMatchesChosen || expected.sessionModel) {
        try {
          const summary = exports.get(sessionID) ?? (await exportSession({ host, cwd: workspace, env, sessionID }))
          exports.set(sessionID, summary)
          if (expected.assistantModel) {
            if (!assistantRefs(summary).includes(modelID(expected.assistantModel))) {
              failures.push(
                `assistant model: expected ${expected.assistantModel}, harness saw ${assistantRefs(summary).join(", ") || "none"}`,
              )
            }
          }
          if (expected.assistantMatchesChosen && chosen) {
            if (!assistantRefs(summary).includes(chosen)) {
              failures.push(
                `assistant model: expected the chosen ${chosen}, harness saw ${assistantRefs(summary).join(", ") || "none"}`,
              )
            }
          }
          if (expected.sessionModel && refString(summary.sessionModel) !== modelID(expected.sessionModel)) {
            failures.push(`session model: expected ${expected.sessionModel}, got ${refString(summary.sessionModel) ?? "none"}`)
          }
          details.push({ session: sessionID, role: record.role, export: summary })
        } catch (error) {
          failures.push(error.message)
        }
      }
      details.push({ decision: record })
    }

    if (unmatched.length > 0) {
      failures.push(
        `unexpected decision records: ${unmatched.map((record) => `${record.role}/${record.agent}/${record.chosen}`).join(", ")}`,
      )
    }

    const ok = failures.length === 0
    scenarioResult.steps.push({
      index: index + 1,
      ok,
      failures,
      chosen: records.map((record) => modelID(record.chosen)).join(", "),
      source: records.map((record) => `${record.stage ?? record.source}/${record.reason}`).join(", "),
      records,
      turns: turnRecords,
      details,
      result,
    })
    if (!ok) {
      scenarioResult.ok = false
      scenarioResult.error = `step ${index + 1}: ${failures[0]}`
      break
    }
  }

  if (scenarioResult.ok && !keep) {
    try {
      fs.rmSync(work, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
  return scenarioResult
}

function printResult(result) {
  const name = result.scenario.id
  if (result.ok) {
    for (const step of result.steps) {
      const summary = step.chosen ? `${step.chosen} · ${step.source}` : "no decision record"
      const rootTurn = (step.turns ?? []).find((turn) => turn.role === "root")
      const timing = rootTurn
        ? ` · judge ${rootTurn.judgeMs}ms · model ${Math.round(rootTurn.modelMs)}ms`
        : ""
      console.log(`PASS  ${name} [${result.scenario.host ?? "opencode"}] step ${step.index}: ${summary}${timing}`)
    }
    return
  }

  console.log(`FAIL  ${name} [${result.scenario.host ?? "opencode"}]: ${result.error}`)
  for (const step of result.steps) {
    if (step.ok) continue
    console.log(`  step ${step.index}`)
    for (const failure of step.failures) console.log(`    - ${failure}`)
    for (const record of step.records) {
      console.log(
        `    decision: ${record.role}/${record.agent || "?"} ${record.chosen} source=${record.source} stage=${record.stage} reason=${record.reason} pinned=${record.pinned} applied=${record.applied}`,
      )
    }
    for (const detail of step.details ?? []) {
      if (detail.export) {
        const summary = detail.export
        console.log(
          `    session ${detail.session ?? detail.role}: model=${refString(summary.sessionModel) ?? "none"} assistant=${assistantRefs(summary).join(",") || "none"}`,
        )
      }
    }
    console.log(`    stdout: ${tail(step.result?.stdout, 4) || "(empty)"}`)
    console.log(`    stderr: ${tail(step.result?.stderr, 6) || "(empty)"}`)
  }
  console.log(`  artifacts: ${result.work}`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return 0
  }

  let scenarios = SCENARIOS
  if (options.host) scenarios = scenarios.filter((scenario) => (scenario.host ?? "opencode") === options.host)
  if (options.only) scenarios = scenarios.filter((scenario) => options.only.has(scenario.id))
  if (!options.realJudge) scenarios = scenarios.filter((scenario) => !scenario.liveOnly)

  if (options.list) {
    for (const scenario of scenarios) {
      const live = scenario.liveOnly ? " (live)" : ""
      console.log(`${scenario.id.padEnd(20)} ${(scenario.host ?? "opencode").padEnd(9)}${live} ${scenario.notes ?? ""}`)
    }
    return 0
  }

  if (scenarios.length === 0) {
    console.error("no scenarios selected")
    return 2
  }

  const stub = startStubJudge()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-e2e-"))
  console.log(`open code router prompt tests · workspace ${root}`)
  console.log(`judge stub ${stub.url} · ${scenarios.length} scenario(s)\n`)

  const results = []
  try {
    for (const scenario of scenarios) {
      const result = await runScenario(scenario, {
        stub,
        root,
        keep: options.keep,
        packageRoot: options.packageRoot ? path.resolve(options.packageRoot) : null,
      })
      results.push(result)
      printResult(result)
      if (result.ok && options.keep) console.log(`  workspace: ${result.work}`)
    }
  } finally {
    stub.stop()
  }

  const failed = results.filter((result) => !result.ok)
  const steps = results.reduce((total, result) => total + result.steps.length, 0)
  console.log(`\n${results.length - failed.length} scenario(s) passed, ${failed.length} failed · ${steps} step(s)`)
  if (failed.length === 0 && !options.keep) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
  return failed.length === 0 ? 0 : 1
}

process.exit(await main())
