import { readConfig, saveConfig } from "./config.js"
import { Judge } from "./judge.js"
import {
  Provisioner,
  confirmThenPull,
  formatBytes,
  judgeAvailability,
} from "./provision.js"
import { resolvePool } from "./pool.js"
import {
  clearPin,
  clearPins,
  readDecisions,
  readTurns,
  sessionHash,
  summariseTurns,
  writePin,
} from "./state.js"
import { buildStatus, formatMilliseconds, formatStatus, formatTiming } from "./status.js"

const HOST = "opencode"

function currentSession(context) {
  try {
    const route = context.ui?.router?.current?.()
    if (route?.type === "session" && route.sessionID) return route.sessionID
  } catch {
    // ignore
  }
  return undefined
}

function currentModel(context) {
  try {
    const model = context.ui?.model?.current?.()
    if (!model?.providerID) return null
    return {
      providerID: model.providerID,
      id: model.id ?? model.modelID,
      variant: model.variant ?? "default",
    }
  } catch {
    return null
  }
}

function parseModel(text) {
  const value = String(text ?? "").trim()
  if (!value.includes("/")) return null
  const [reference, variant] = value.split("#")
  const [providerID, ...rest] = reference.split("/")
  const id = rest.join("/")
  if (!providerID || !id) return null
  return { providerID, id, variant: variant ?? "default" }
}

function modelLabel(reference) {
  if (!reference) return "none"
  return `${reference.providerID}/${reference.id ?? reference.modelID}${reference.variant ? `#${reference.variant}` : ""}`
}

async function show(context, message, title = "oMLX Router") {
  if (context.ui?.dialog?.alert) {
    await context.ui.dialog.alert({ title, message })
  } else {
    await context.ui.toast.show({ title, message })
  }
}

function poolLines(config, models, providers) {
  const resolved = resolvePool({ models, providers, config, host: HOST })
  const lines = [`source ${resolved.source} · ${resolved.pool.length} usable · ${resolved.candidates} available`]
  for (const model of resolved.pool) {
    lines.push(
      [
        `${model.providerID}/${model.modelID}${model.variant && model.variant !== "default" ? `#${model.variant}` : ""}`,
        `ctx=${model.limit.context}`,
        `local=${model.local ? "yes" : "no"}`,
        `quality=${model.qualityOverride ?? "auto"}`,
      ].join(" · "),
    )
  }
  for (const warning of resolved.warnings) lines.push(`warning: ${warning}`)
  return lines.join("\n")
}

function taskLine(task) {
  const total = Number(task.total_size) || 0
  const done = Number(task.downloaded_size) || 0
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : Number(task.progress) || 0
  return `${task.repo_id} · ${task.status} · ${percent}% (${formatBytes(done)} / ${formatBytes(total)})`
}

async function offerPull(context, config, repo, reason, background) {
  const provision = new Provisioner({ config })
  let result
  try {
    result = await confirmThenPull({
      provision,
      repo: repo || provision.defaultRepo(),
      confirm: async (summary) => {
        const lines = [
          reason ? `${reason}\n` : "",
          `Model    ${summary.repo}`,
          summary.params ? `Params   ${summary.params}` : "",
          `Weights  ${summary.weightsFormatted}`,
          `Download ${summary.sizeFormatted} (all files)`,
          `License  ${summary.license}`,
          `Source   Hugging Face · MLX: ${summary.mlx ? "yes" : "no"}`,
          "",
          "This downloads into oMLX's model directory and is served locally.",
        ].filter(Boolean)
        return context.ui.dialog.confirm({
          title: "Download judge model",
          message: lines.join("\n"),
          label: { confirm: "Download", cancel: "Cancel" },
        })
      },
    })
  } catch (error) {
    await show(context, `cannot prepare download: ${error?.message ?? error}`)
    return
  }

  if (!result.approved) {
    await context.ui.toast.show({ title: "oMLX Router", message: "download cancelled" })
    return
  }

  await context.ui.toast.show({
    title: "oMLX Router",
    message: `downloading ${result.summary.repo} (${result.summary.sizeFormatted}); check /router judge status`,
    variant: "success",
    duration: 5000,
  })

  if (background === false) return
  const taskID = result.task.task_id
  void provision
    .waitFor(taskID, {
      onProgress: (task) => {
        if (task.status === "completed") {
          void context.ui.toast.show({
            title: "oMLX Router",
            message: `${task.repo_id} downloaded; run /router judge to verify`,
            variant: "success",
            duration: 8000,
          })
        }
        if (task.status === "failed" || task.status === "cancelled") {
          void context.ui.toast.show({
            title: "oMLX Router",
            message: `download ${task.status}: ${task.error || "no detail"}`,
            variant: "error",
            duration: 8000,
          })
        }
      },
    })
    .catch((error) => {
      void context.ui.toast.show({
        title: "oMLX Router",
        message: `download monitor stopped: ${error?.message ?? error}`,
        variant: "error",
      })
    })
}

async function judgeTasks(context, config) {
  const provision = new Provisioner({ config })
  try {
    const tasks = await provision.tasks()
    if (tasks.length === 0) {
      await show(context, "no judge downloads")
      return
    }
    await show(context, tasks.map(taskLine).join("\n"))
  } catch (error) {
    await show(context, `cannot read downloads: ${error?.message ?? error}`)
  }
}

async function cancelJudgeTask(context, config, taskID) {
  const provision = new Provisioner({ config })
  try {
    const tasks = await provision.tasks()
    const active = tasks.filter((task) => ["pending", "downloading"].includes(task.status))
    const target = taskID ? tasks.find((task) => task.task_id === taskID) : active[0]
    if (!target) {
      await show(context, taskID ? `no task ${taskID}` : "no active download")
      return
    }
    const approved = await context.ui.dialog.confirm({
      title: "Cancel download",
      message: taskLine(target),
      label: { confirm: "Cancel download", cancel: "Keep" },
    })
    if (!approved) return
    await provision.cancel(target.task_id)
    await context.ui.toast.show({ title: "oMLX Router", message: "download cancelled", variant: "success" })
  } catch (error) {
    await show(context, `cannot cancel download: ${error?.message ?? error}`)
  }
}

async function runCommand(context, input) {
  const [command = "status", ...rest] = String(input ?? "").trim().split(/\s+/)
  const config = readConfig({ write: true }).config
  const sessionID = currentSession(context)

  switch (command) {
    case "":
    case "status": {
      await show(context, formatStatus(buildStatus({ host: HOST })))
      return
    }
    case "on":
    case "off": {
      saveConfig({ ...config, enabled: command === "on" })
      await context.ui.toast.show({ title: "oMLX Router", message: `routing ${command}`, variant: "success" })
      return
    }
    case "policy": {
      if (rest[0]) {
        if (!["cost", "quality", "latency"].includes(rest[0])) {
          await show(context, "policy must be cost, quality, or latency")
          return
        }
        saveConfig({ ...config, policy: rest[0] })
        clearPins(HOST)
        await context.ui.toast.show({ title: "oMLX Router", message: `policy ${rest[0]}`, variant: "success" })
        return
      }
      const choice = await context.ui.dialog.select({
        title: "oMLX Router policy",
        current: config.policy,
        options: [
          { title: "Cost first", value: "cost", description: "Cheapest model that clears the bar; escalate when needed" },
          { title: "Quality first", value: "quality", description: "Strongest capable model; cost is a tiebreak" },
          { title: "Latency first", value: "latency", description: "Fastest capable model, favouring local and flash tiers" },
        ],
      })
      if (!choice) return
      saveConfig({ ...config, policy: choice })
      clearPins(HOST)
      await context.ui.toast.show({ title: "oMLX Router", message: `policy ${choice}`, variant: "success" })
      return
    }
    case "pool": {
      const location = context.location ?? context.data.location.default()
      try {
        await Promise.all([
          context.data.location.model.sync(location),
          context.data.location.provider.sync(location),
        ])
      } catch {
        // best effort
      }
      const models = context.data.location.model.list(location) ?? []
      const providers = context.data.location.provider.list(location) ?? []
      await show(context, poolLines(config, models, providers))
      return
    }
    case "history": {
      const limit = Number(rest[0]) || 10
      const decisions = readDecisions(HOST, limit)
      if (decisions.length === 0) {
        await show(context, "no decisions recorded yet")
        return
      }
      const lines = decisions.map((record) => {
        const when = new Date(record.ts ?? Date.now()).toLocaleTimeString()
        const role = record.role === "subagent" ? `sub(${record.agent ?? "?"})` : "root"
        const timing = record.timing ?? {}
        return `${when} ${role} ${record.chosen ?? "?"} ${record.pinned ? "pinned" : "switched"} ${record.stage ?? ""} · judge ${formatMilliseconds(timing.judgeMs ?? record.judge?.ms ?? 0)} route ${formatMilliseconds(timing.routeMs ?? 0)}`
      })
      await show(context, lines.join("\n"))
      return
    }
    case "timing": {
      const limit = Number(rest[0]) || 20
      const turns = readTurns(HOST, limit)
      if (turns.length === 0) {
        await show(context, "no turn timings recorded yet")
        return
      }
      const summary = summariseTurns(turns, limit)
      const lines = [formatTiming(summary) ?? "no turn timings", ""]
      for (const turn of turns.slice(-10)) {
        const when = new Date(turn.ts ?? Date.now()).toLocaleTimeString()
        const role = turn.role === "subagent" ? `sub(${turn.agent || "?"})` : "root"
        lines.push(
          `${when} ${role} ${turn.usedModel ?? turn.model ?? "?"} · judge ${formatMilliseconds(turn.judgeMs)} · model ${formatMilliseconds(turn.modelMs)} · tools ${formatMilliseconds(turn.toolMs)} · turn ${formatMilliseconds(turn.turnMs)}`,
        )
      }
      await show(context, lines.join("\n"))
      return
    }
    case "explain": {
      const hash = sessionID ? sessionHash(sessionID) : null
      const decisions = readDecisions(HOST, 100).reverse()
      const record = decisions.find((entry) => !hash || entry.session === hash)
      await show(context, record ? JSON.stringify(record, null, 2) : "no decision for this session yet")
      return
    }
    case "pin": {
      if (!sessionID) {
        await show(context, "no active session")
        return
      }
      const reference = parseModel(rest.join(" ")) ?? currentModel(context)
      if (!reference) {
        await show(context, "pass provider/model or select a model first")
        return
      }
      writePin(HOST, sessionID, {
        model: reference,
        forced: true,
        source: "user",
        since: Date.now(),
        lastApplied: reference,
        lastContextTokens: 0,
      })
      await context.ui.toast.show({ title: "oMLX Router", message: `pinned ${modelLabel(reference)}`, variant: "success" })
      return
    }
    case "auto": {
      if (!sessionID) {
        await show(context, "no active session")
        return
      }
      clearPin(HOST, sessionID)
      await context.ui.toast.show({ title: "oMLX Router", message: "routing resumed", variant: "success" })
      return
    }
    case "judge": {
      const action = rest[0]
      if (action === "pull") {
        if (config.judge.provision?.enabled === false) {
          await show(context, "judge provisioning is disabled in config (judge.provision.enabled)")
          return
        }
        await offerPull(context, config, rest[1], "No suitable judge model is loaded.")
        return
      }
      if (action === "status") {
        await judgeTasks(context, config)
        return
      }
      if (action === "cancel") {
        await cancelJudgeTask(context, config, rest[1])
        return
      }

      const availability = await judgeAvailability({ config })
      if (!availability.available || !availability.suitable) {
        const reason = !availability.available
          ? `No judge model is available (${availability.error ?? "oMLX returned no models"}).`
          : `The smallest advertised model is ${availability.selected}, which is larger than the recommended 4B judge.`
        if (config.judge.provision?.enabled === false) {
          await show(context, `${reason}\n\nProvisioning is disabled; pull a model in oMLX.`)
          return
        }
        await offerPull(context, config, undefined, reason)
        return
      }

      const judge = new Judge({ config: config.judge })
      try {
        const probe = await judge.probe()
        const lines = [
          `models   ${probe.models.join(", ")}`,
          `selected ${probe.selected}`,
          `latency  ${probe.ms} ms`,
          `sample   ${probe.sample ? JSON.stringify(probe.sample) : "unparsable"}`,
        ]
        await show(context, lines.join("\n"))
      } catch (error) {
        await show(context, `judge unavailable: ${error?.message ?? error}`)
      }
      return
    }
    case "subagents": {
      const enabled = rest[0] !== "off"
      saveConfig({ ...config, subagents: { ...config.subagents, enabled } })
      await context.ui.toast.show({
        title: "oMLX Router",
        message: `subagent routing ${enabled ? "on" : "off"}`,
        variant: "success",
      })
      return
    }
    case "help": {
      await show(
        context,
        [
          "/router — status",
          "/router on | off",
          "/router policy [cost|quality|latency]",
          "/router pool",
          "/router history [n]",
          "/router timing [n]",
          "/router explain",
          "/router pin [provider/model]",
          "/router auto",
          "/router judge [pull|status|cancel]",
          "/router subagents on|off",
        ].join("\n"),
      )
      return
    }
    default:
      await show(context, `unknown command: ${command}. Try /router help`)
  }
}

/**
 * OpenCode TUI part. Plain object export, no JSX, no TypeScript.
 *
 * Status and settings live here rather than in a server command because
 * `ctx.session.synthetic` starts a model turn (see docs/development.md).
 */
export default {
  id: "omlx.router.tui",

  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "omlx.router.settings",
          title: "oMLX Router: settings",
          group: "oMLX Router",
          palette: true,
          slash: { name: "router", arguments: true },
          run: async (input) => {
            try {
              await runCommand(context, input)
            } catch (error) {
              await show(context, `router error: ${error?.message ?? error}`)
            }
          },
        },
      ],
      bindings: ["omlx.router.settings"],
    }))
  },
}
