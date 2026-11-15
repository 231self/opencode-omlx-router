import { readConfig } from "./config.js"
import { Judge } from "./judge.js"
import { resolvePool } from "./pool.js"
import { applyPlan, buildOptimiseRequest } from "./optimiser.js"
import {
  appendDecision,
  clearPin,
  readPin,
  readStats,
  sessionHash,
  writePin,
  writeStats,
} from "./state.js"
import { countContextTokens, estimateTokens } from "./tokens.js"

export function refOf(model) {
  if (!model) return null
  const id = model.id ?? model.modelID
  if (!id || !model.providerID) return null
  return { providerID: model.providerID, id, variant: model.variant ?? "default" }
}

function sameModel(left, right) {
  if (!left || !right) return false
  return left.providerID === right.providerID && left.id === right.id
}

function sameModelAndVariant(left, right) {
  if (!sameModel(left, right)) return false
  return (left.variant ?? "default") === (right.variant ?? "default")
}

function decisionRef(decision) {
  return {
    providerID: decision.providerID,
    id: decision.id,
    variant: decision.variant ?? "default",
  }
}

function countImages(files) {
  if (!Array.isArray(files)) return 0
  return files.filter((file) => {
    const media = String(file?.mediaType ?? file?.mime ?? file?.media ?? "")
    return media.startsWith("image/") || file?.type === "image"
  }).length
}

function pinForRequest(pin) {
  if (!pin?.model) return null
  return {
    model: pin.model,
    since: Number(pin.since) || 0,
    lastTurnAt: Number(pin.lastTurnAt) || 0,
    lastTurnClass: pin.lastTurnClass ?? "",
    lastComplexity: Number(pin.lastComplexity) || 0,
    switchCount: Number(pin.switchCount) || 0,
    away: Array.isArray(pin.away) ? pin.away : [],
    source: pin.source ?? "",
    forced: Boolean(pin.forced),
  }
}

/**
 * Host-independent routing orchestration: reads host state, applies the core
 * decision, persists pins/decisions, and drives the judge.
 */
export class Router {
  constructor({
    ctx,
    host = "opencode",
    env = process.env,
    core = null,
    judge = null,
    telemetry = null,
    configOptions = {},
    appliedMode = "same-turn",
  } = {}) {
    this.ctx = ctx
    this.host = host
    this.env = env
    this.core = core
    this.judge = judge ?? new Judge({ config: {}, env })
    this.telemetry = telemetry
    this.configOptions = configOptions
    this.appliedMode = appliedMode
    this.failures = new Map()
    this.lastJudgeError = null
  }

  config() {
    return readConfig({ env: this.env, seed: this.configOptions, write: true }).config
  }

  async session(sessionID) {
    try {
      return await this.ctx.session.get({ sessionID })
    } catch {
      return null
    }
  }

  async agent(agentID) {
    if (!agentID || !this.ctx.agent?.get) return null
    try {
      return await this.ctx.agent.get({ agentID })
    } catch {
      return null
    }
  }

  async catalog() {
    const now = Date.now()
    if (this.catalogCache && now - this.catalogCache.at < 2000) return this.catalogCache.value
    let models = []
    let providers = []
    try {
      const value = await this.ctx.model?.list()
      models = Array.isArray(value) ? value : (value?.data ?? [])
    } catch {
      models = []
    }
    try {
      const value = await this.ctx.provider?.list()
      providers = Array.isArray(value) ? value : (value?.data ?? [])
    } catch {
      providers = []
    }
    const value = { models, providers }
    this.catalogCache = { at: now, value }
    return value
  }

  /**
   * The V2 context hook reports only provider/id, not limits or prices. Fill in
   * the catalog entry so the optimiser sees the real context budget instead of
   * treating every turn as an overflow.
   */
  async modelFor(contextModel) {
    if (!contextModel) return null
    if (Number(contextModel.limit?.context) > 0) return contextModel
    const { models } = await this.catalog()
    const found = models.find(
      (model) =>
        String(model?.providerID) === String(contextModel.providerID) &&
        String(model?.id ?? model?.modelID) === String(contextModel.id),
    )
    return found ? { ...found, providerID: found.providerID, id: found.id ?? found.modelID } : contextModel
  }

  async prompt(event) {
    const promptStarted = Date.now()
    try {
      const config = this.config()
      if (!config.enabled || !this.core) return
      const sessionID = event?.sessionID
      if (!sessionID) return

      const info = await this.session(sessionID)
      const agent = await this.agent(info?.agent)
      const parent = info?.parentID ? await this.session(info.parentID) : null
      let pin = readPin(this.host, sessionID, this.env)
      const current = refOf(info?.model)

      if (pin?.model && pin.lastApplied && current && !sameModel(current, pin.lastApplied)) {
        pin = { ...pin, forced: true, source: "user", model: current }
      }

      const { models, providers } = await this.catalog()
      const resolved = resolvePool({ models, providers, config, host: this.host, env: this.env })
      if (config.debug) {
        console.log("[omlx-router] pool", {
          host: this.host,
          source: resolved.source,
          models: models.length,
          providers: providers.length,
          size: resolved.pool.length,
          warnings: resolved.warnings,
        })
      }
      const lastContextTokens = Number(pin?.lastContextTokens) || 0
      const promptText = String(event?.prompt?.text ?? "")
      const stats = readStats(this.host, this.env) ?? { decisions: 0, switches: 0 }

      const request = {
        abi: 1,
        nowMs: Date.now(),
        host: this.host,
        kind: "primary",
        role: info?.parentID ? "subagent" : "root",
        session: {
          hash: sessionHash(sessionID),
          parentHash: info?.parentID ? sessionHash(info.parentID) : null,
          agentID: info?.agent ?? "",
          agentMode: agent?.mode ?? "",
          agentModel: refOf(agent?.model),
          currentModel: current,
          parentModel: refOf(parent?.model),
        },
        turn: {
          promptText,
          promptTokens: estimateTokens(promptText),
          images: countImages(event?.prompt?.files),
          lastContextTokens,
          toolFailures: this.failures.get(sessionID)?.count ?? 0,
          turnClassHint: null,
        },
        pool: resolved.pool,
        settings: config,
        pin: pinForRequest(pin),
        judge: { verdict: null, cached: false, unavailable: false },
        stats,
      }

      let coreMs = 0
      let coreStarted = Date.now()
      let result = this.core.route(request)
      coreMs += Date.now() - coreStarted
      let judgeMs = null
      if (result.action === "need_judge" && result.judgeRequest) {
        this.judge.configure(config.judge)
        const judgeStarted = Date.now()
        try {
          const judged = await this.judge.verdict({
            prompt: result.judgeRequest.prompt,
            cacheKey: result.judgeRequest.cacheKey,
          })
          request.judge = { verdict: judged.verdict, cached: Boolean(judged.cached), unavailable: false }
          judgeMs = judged.ms ?? Date.now() - judgeStarted
        } catch (error) {
          request.judge = { verdict: null, cached: false, unavailable: true }
          judgeMs = Date.now() - judgeStarted
          this.lastJudgeError = String(error?.message ?? error)
        }
        coreStarted = Date.now()
        result = this.core.route(request)
        coreMs += Date.now() - coreStarted
      }

      if (result.action !== "decide" || !result.decision) {
        this.record(result, config)
        return
      }

      let switched = false
      let switchError = null
      let switchMs = 0
      if (!sameModelAndVariant(current, decisionRef(result.decision))) {
        const switchStarted = Date.now()
        try {
          const model = { providerID: result.decision.providerID, id: result.decision.id }
          if (result.decision.variant) model.variant = result.decision.variant
          await this.ctx.session.switchModel({ sessionID, model })
          switched = true
        } catch (error) {
          switchError = String(error?.message ?? error)
        } finally {
          switchMs = Date.now() - switchStarted
        }
      }

      const applied = switchError ? current : decisionRef(result.decision)
      const nextPin = {
        ...(result.pin ?? {}),
        lastApplied: applied,
        lastContextTokens,
      }
      if (nextPin.model) {
        // The context hook also writes this file. Merge with the latest pin so
        // a concurrent context write cannot drop the model or routing state.
        const latest = readPin(this.host, sessionID, this.env) ?? {}
        const merged = { ...latest, ...nextPin }
        if (!nextPin.lastContextTokens) merged.lastContextTokens = Number(latest.lastContextTokens) || 0
        writePin(this.host, sessionID, merged, this.env)
      }
      if (result.state) writeStats(this.host, result.state, this.env)
      const routeMs = Date.now() - promptStarted
      this.record(result, config, {
        switched,
        switchError,
        judgeMs,
        routeMs,
        coreMs,
        switchMs,
      })
      this.telemetry?.notePrompt(sessionID, {
        at: promptStarted,
        routeMs,
        judgeMs: judgeMs ?? 0,
        coreMs,
        switchMs,
        chosen: result.action === "decide" ? decisionRef(result.decision) : current,
        role: request.role,
        agent: request.session.agentID,
        complexity: result.decision?.complexity ?? result.log?.complexity,
        turnClass: result.log?.turnClass,
        promptTokens: request.turn.promptTokens,
      })
    } catch (error) {
      if (this.config().debug) console.error("[omlx-router] prompt failed:", String(error?.message ?? error))
    }
  }

  record(result, config, extra = {}) {
    const log = result.log ?? null
    if (!log) return
    if (log.reason === "disabled" || log.reason === "subagents_disabled") return
    const record = {
      ...log,
      applied: result.action === "decide" ? (extra.switchError ? "none" : this.appliedMode) : "none",
      error: extra.switchError ?? null,
      timing: {
        routeMs: Number(extra.routeMs) || 0,
        judgeMs: Number(extra.judgeMs) || 0,
        coreMs: Number(extra.coreMs) || 0,
        switchMs: Number(extra.switchMs) || 0,
      },
      judge: {
        ...(log.judge ?? {}),
        cached: Boolean(result.action === "need_judge" ? false : log.judge?.cached),
        ...(extra.judgeMs != null ? { ms: extra.judgeMs } : {}),
      },
    }
    try {
      appendDecision(this.host, record, this.env)
    } catch (error) {
      if (config?.debug) console.error("[omlx-router] cannot write decision:", String(error?.message ?? error))
    }
  }

  /** Apply the optimiser to a message list without session state (Kilo transform). */
  contextMessages({ model, messages, system = [] }) {
    try {
      const config = this.config()
      if (config.optimiser?.enabled === false || !this.core?.optimise || !model) return null
      const request = buildOptimiseRequest({ model, config, system, messages })
      const result = this.core.optimise(request)
      if (!result?.stats || result.stats.overflow) return result?.stats ?? null
      applyPlan(messages, result.plan)
      return result.stats
    } catch {
      return null
    }
  }

  async context(event) {
    try {
      const sessionID = event?.sessionID
      if (!sessionID) return
      const config = this.config()
      const model = await this.modelFor(event?.model)
      let tokens = null
      let optimiser = null
      let overflow = false

      if (config.optimiser?.enabled !== false && this.core?.optimise && model) {
        const request = buildOptimiseRequest({
          model,
          config,
          system: event.system,
          messages: event.messages,
        })
        const result = this.core.optimise(request)
        if (result?.stats) {
          optimiser = result.stats
          if (result.stats.overflow) {
            overflow = true
            tokens = Number(result.stats.beforeTokens) || 0
          } else {
            applyPlan(event.messages, result.plan)
            tokens = Number(result.stats.afterTokens) || 0
          }
        }
      }

      if (tokens == null) tokens = countContextTokens(event)
      const latest = readPin(this.host, sessionID, this.env) ?? {}
      const target = refOf(model)
      // A newer prompt may have chosen a different model while this hook was
      // measuring. Never overwrite that decision with stale context state.
      if (latest.model && target && !sameModel(latest.model, target)) return
      if (overflow) clearPin(this.host, sessionID, this.env)
      writePin(
        this.host,
        sessionID,
        { ...(overflow ? {} : latest), lastContextTokens: tokens, lastOptimiser: optimiser },
        this.env,
      )
    } catch {
      // A failed measurement or prune must never break a turn.
    }
  }

  compaction(event) {
    const sessionID = event?.sessionID
    if (!sessionID) return
    try {
      clearPin(this.host, sessionID, this.env)
    } catch {
      // ignore
    }
    this.failures.delete(sessionID)
  }

  toolAfter(event) {
    const sessionID = event?.sessionID
    if (!sessionID) return
    if (event?.status === "error") {
      const previous = this.failures.get(sessionID)
      const tool = String(event?.tool ?? "")
      const count = previous && previous.tool === tool ? previous.count + 1 : 1
      this.failures.set(sessionID, { tool, count })
    } else {
      this.failures.delete(sessionID)
    }
  }
}
