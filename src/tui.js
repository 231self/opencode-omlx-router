import { configPath, readConfig, saveConfig } from "./config.js"
import { Judge } from "./judge.js"
import {
  Provisioner,
  confirmThenPull,
  formatBytes,
  judgeAvailability,
} from "./provision.js"
import { readHostModelState, resolvePool } from "./pool.js"
import {
  clearPin,
  clearPins,
  readDecisions,
  readTurns,
  sessionHash,
  summariseTurns,
  writePin,
} from "./state.js"
import { buildStatus, formatMilliseconds, formatStatus, formatTiming, formatTuiStatus } from "./status.js"

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
        `cost=${formatCost(model.cost)}`,
        `local=${model.local ? "yes" : "no"}`,
        `quality=${model.qualityOverride ?? "auto"}`,
      ].join(" · "),
    )
  }
  for (const warning of resolved.warnings) lines.push(`warning: ${warning}`)
  lines.push("")
  lines.push(`config ${configPath()}`)
  lines.push("set models: omlx-router config set pool.source list")
  lines.push(`            omlx-router config set pool.models '["provider/model", "..."]'`)
  return lines.join("\n")
}

function formatCost(cost) {
  const tier = Array.isArray(cost) ? cost[0] : null
  if (!tier) return "free/unknown"
  return `$${tier.input}/$${tier.output}`
}

function explainLines(record) {
  const lines = [
    `chosen   ${record.chosen ?? "none"}${record.pinned ? " · pinned" : ""}`,
    `source   ${record.source ?? "?"} · ${record.reason ?? "?"} · ${record.stage ?? ""}`,
    `policy   ${record.policy ?? "?"} · complexity ${record.complexity ?? "?"} · ${record.turnClass ?? "?"}`,
    `applied  ${record.applied ?? "?"}${record.error ? ` · error ${record.error}` : ""}`,
  ]
  const verdict = record.verdict
  if (verdict) {
    lines.push(
      `verdict  ${verdict.task}/${verdict.complexity} · ${verdict.reasoningNeed} reasoning · ${verdict.contextNeed} context · tools ${verdict.needsTools ? "yes" : "no"} · confidence ${Number(verdict.confidence ?? 0).toFixed(2)}`,
    )
  }
  const judge = record.judge ?? {}
  if (judge.used !== undefined || judge.ms !== undefined) {
    lines.push(`judge    used ${judge.used ? "yes" : "no"} · cached ${judge.cached ? "yes" : "no"} · ${judge.ms ?? 0} ms`)
  }
  const timing = record.timing
  if (timing) {
    lines.push(`timing   route ${formatMilliseconds(timing.routeMs)} · judge ${formatMilliseconds(timing.judgeMs)} · switch ${formatMilliseconds(timing.switchMs)}`)
  }
  const top = Array.isArray(record.top) ? record.top : []
  if (top.length > 0) {
    lines.push("top")
    for (const entry of top) {
      lines.push(
        `  ${entry.providerID}/${entry.id}${entry.variant && entry.variant !== "default" ? `#${entry.variant}` : ""}  score ${Number(entry.score ?? 0).toFixed(3)}  cost $${Number(entry.costUsd ?? 0).toFixed(6)}`,
      )
    }
  }
  if (record.hint) lines.push(`hint     ${record.hint}`)
  return lines.join("\n")
}

async function poolCatalog(context) {
  const location = context.location ?? context.data.location.default()
  try {
    await Promise.all([
      context.data.location.model.sync(location),
      context.data.location.provider.sync(location),
    ])
  } catch {
    // best effort; the cached lists may still be usable
  }
  return {
    models: context.data.location.model.list(location) ?? [],
    providers: context.data.location.provider.list(location) ?? [],
  }
}

async function poolMenu(context) {
  const { models, providers } = await poolCatalog(context)
  let config = readConfig({ write: true }).config
  let resolved = resolvePool({ models, providers, config, host: HOST })

  if (resolved.pool.length > 0) {
    await show(context, poolLines(config, models, providers))
    const choice = await context.ui.dialog.select({
      title: "oMLX Router pool",
      options: [
        {
          title: "Change pool",
          value: "change",
          description: "Choose host favorites, an explicit list, or every available model",
        },
        { title: "Keep current pool", value: "close", description: "Leave routing unchanged" },
      ],
    })
    if (choice !== "change") return
  }

  const source = await context.ui.dialog.select({
    title: resolved.pool.length > 0 ? "oMLX Router pool source" : "No models selected · choose a pool",
    options: [
      {
        title: "Use my favorites",
        value: "favorites",
        description: "Favorite models in OpenCode's model picker; routing reads them",
      },
      {
        title: "Enter an explicit list",
        value: "list",
        description: "Comma-separated provider/model names",
      },
      {
        title: "Use all available models",
        value: "available",
        description: "Explicit opt-in; cost-first may pick zero-cost models",
      },
      { title: "Cancel", value: "cancel", description: "Leave the current pool unchanged" },
    ],
  })
  if (!source || source === "cancel") return

  if (source === "favorites") {
    const favorites = readHostModelState(HOST)
    saveConfig({ ...config, pool: { ...config.pool, source: "favorites" } })
    clearPins(HOST)
    if (favorites.favorite.length === 0) {
      await show(
        context,
        "Pool source is now favorites, but you have not favorited any models yet.\n\n" +
          "Open OpenCode's model picker and favorite the models you want, then run /router pool again.\n\n" +
          "Or run /router pool and choose 'Enter an explicit list' to name them directly.",
      )
    } else {
      await context.ui.toast.show({
        title: "oMLX Router",
        message: `favorites pool · ${favorites.favorite.length} model(s)`,
        variant: "success",
      })
    }
    return
  }

  if (source === "list") {
    if (!context.ui.dialog.prompt) {
      await show(context, "This host has no text prompt. Edit pool.models in " + configPath() + ".")
      return
    }
    const text = await context.ui.dialog.prompt({
      title: "Models for the router",
      placeholder: "deepseek/deepseek-flash, deepseek/deepseek-v4-pro",
    })
    if (!text) return
    const references = String(text)
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
    if (references.length === 0) {
      await show(context, "Enter at least one provider/model.")
      return
    }
    const available = new Set(models.map((model) => `${model.providerID}/${model.id ?? model.modelID}`))
    const missing = references.filter((reference) => !available.has(reference.split("#")[0]))
    if (missing.length > 0) {
      await show(
        context,
        `Not in the host model catalog: ${missing.join(", ")}\n\n` +
          `Examples: ${[...available].slice(0, 6).join(", ") || "(none advertised)"}`,
      )
      return
    }
    saveConfig({ ...config, pool: { ...config.pool, source: "list", models: references } })
    clearPins(HOST)
    await context.ui.toast.show({
      title: "oMLX Router",
      message: `pool · ${references.length} model(s)`,
      variant: "success",
    })
    return
  }

  if (source === "available") {
    const confirmed = await context.ui.dialog.confirm({
      title: "Use every available model?",
      message:
        "This opts into all eligible chat models. Cost-first routing may choose free or zero-cost models.\n\nContinue?",
      label: { confirm: "Use all", cancel: "Cancel" },
    })
    if (!confirmed) return
    saveConfig({ ...config, pool: { ...config.pool, source: "available" } })
    clearPins(HOST)
    await context.ui.toast.show({
      title: "oMLX Router",
      message: "pool · all available models",
      variant: "success",
    })
  }
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

async function openMenu(context) {
  if (!context.ui?.dialog?.select) {
    await show(context, formatTuiStatus(buildStatus({ host: HOST })))
    return
  }
  for (;;) {
    const config = readConfig({ write: true }).config
    const choice = await context.ui.dialog.select({
      title: "oMLX Router  ·  arrows move  ·  enter select",
      options: [
        { title: "Status", value: "status", description: "State, judge, pool, pins, and the last decision" },
        { title: "Policy", value: "policy", description: "Cost / quality / latency; clears pins when changed" },
        { title: "Pool", value: "pool", description: "Models available to the router and how to edit them" },
        { title: "Timing", value: "timing", description: "Local judge vs remote model vs tool time" },
        { title: "History", value: "history", description: "Recent per-turn decisions, including subagents" },
        { title: "Explain last decision", value: "explain", description: "Why this session chose or kept its model" },
        { title: "Judge", value: "judge", description: "Probe the local judge or pull the recommended model" },
        { title: "Pin current model", value: "pin", description: "Force this session to the currently selected model" },
        { title: "Release pin", value: "auto", description: "Resume automatic routing for this session" },
        {
          title: config.enabled ? "Disable routing" : "Enable routing",
          value: "toggle-routing",
          description: "Turn the router on or off without uninstalling it",
        },
        {
          title: config.subagents.enabled ? "Disable subagents" : "Enable subagents",
          value: "toggle-subagents",
          description: "Route child sessions with their agent policy",
        },
        { title: "Help", value: "help", description: "Command reference" },
        { title: "Close", value: "close", description: "Close the router menu" },
      ],
    })
    if (!choice || choice === "close") return
    if (choice === "toggle-routing") {
      await runCommand(context, config.enabled ? "off" : "on")
    } else if (choice === "toggle-subagents") {
      await runCommand(context, `subagents ${config.subagents.enabled ? "off" : "on"}`)
    } else {
      await runCommand(context, choice)
    }
  }
}

async function runCommand(context, input) {
  const [command = "menu", ...rest] = String(input ?? "").trim().split(/\s+/)
  const config = readConfig({ write: true }).config
  const sessionID = currentSession(context)

  switch (command) {
    case "":
    case "menu": {
      await openMenu(context)
      return
    }
    case "status": {
      await show(context, formatTuiStatus(buildStatus({ host: HOST })))
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
      await poolMenu(context)
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
      await show(context, record ? explainLines(record) : "no decision for this session yet")
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
          "/router — action menu",
          "/router status",
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
  id: "omlx-router.tui",

  setup(context) {
    const disposers = []

    try {
      const config = readConfig({ write: false }).config
      const favorites = readHostModelState(HOST)
      const noFavorites = config.pool.source === "favorites" && favorites.favorite.length === 0
      const noList =
        config.pool.source === "list" &&
        config.pool.models.length === 0 &&
        (config.pool.include ?? []).length === 0
      const noSource = !["favorites", "list", "available"].includes(config.pool.source)
      if (noFavorites || noList || noSource) {
        void context.ui.toast.show({
          title: "oMLX Router",
          message: "No models selected. Open /router pool to choose favorites or an explicit list.",
          duration: 8000,
        })
      }
    } catch {
      // A missing config or toast must not stop the TUI part.
    }

    if (typeof context.data?.on === "function") {
      const refresh = async (event) => {
        const sessionID = event?.data?.sessionID ?? event?.sessionID
        if (!sessionID) return
        try {
          context.data.session?.invalidate?.(sessionID)
          await context.data.session?.sync?.(sessionID)
        } catch {
          // The host refreshes on its next event; routing must not be affected.
        }
      }

      disposers.push(
        context.data.on("session.model.selected", (event) => {
          const model = event?.data?.model
          const previous = event?.data?.previous
          const changed =
            model &&
            (!previous ||
              previous.providerID !== model.providerID ||
              previous.id !== model.id)
          if (changed) {
            void context.ui.toast.show({
              title: "oMLX Router",
              message: `model → ${model.providerID}/${model.id}`,
              duration: 3000,
            })
          }
          void refresh(event)
        }),
      )
      disposers.push(context.data.on("session.execution.succeeded", (event) => void refresh(event)))
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "omlx-router.settings",
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
      bindings: ["omlx-router.settings"],
    }))

    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // Cleanup must not mask unload.
        }
      }
    }
  },
}
