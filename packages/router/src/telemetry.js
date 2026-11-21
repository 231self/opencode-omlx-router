import { appendTurn, sessionHash } from "./state.js"

export const TELEMETRY_EVENTS = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.step.started",
  "session.step.first-token",
  "session.step.ended",
]

function modelRef(model) {
  if (!model) return null
  const id = model.id ?? model.modelID
  if (!id || !model.providerID) return null
  return `${model.providerID}/${id}`
}

function emptyTokens() {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function addTokens(target, tokens) {
  if (!tokens) return target
  target.input += Number(tokens.input) || 0
  target.output += Number(tokens.output) || 0
  target.reasoning += Number(tokens.reasoning) || 0
  target.cache.read += Number(tokens.cache?.read) || 0
  target.cache.write += Number(tokens.cache?.write) || 0
  return target
}

/**
 * Host turn telemetry built from public server events.
 *
 * The prompt hook records routing cost (including the judge). The host events
 * then report model-step and execution durations. A turn record separates:
 * route (core + judge + switch), remote model calls, and tool/other time.
 */
export class Telemetry {
  constructor({ host = "opencode", env = process.env } = {}) {
    this.host = host
    this.env = env
    this.sessions = new Map()
    this.pending = new Map()
  }

  /** Called at the end of the prompt hook for one admitted user turn. */
  notePrompt(sessionID, info = {}) {
    if (!sessionID) return
    this.pending.set(String(sessionID), {
      ...info,
      at: Number(info.at) || Date.now(),
      chosen: modelRef(info.chosen) ?? info.chosen ?? null,
    })
  }

  state(sessionID) {
    let state = this.sessions.get(sessionID)
    if (!state) {
      state = { executionStartedAt: null, steps: [], finish: null }
      this.sessions.set(sessionID, state)
    }
    return state
  }

  async subscribe(events) {
    for await (const event of events) this.handle(event)
  }

  handle(event) {
    try {
      const type = String(event?.type ?? "")
      const data = event?.data ?? {}
      const sessionID = data.sessionID
      if (!sessionID) return
      const created = Number(event?.created)
      if (!Number.isFinite(created) || created <= 0) return
      const state = this.state(sessionID)

      if (type === "session.execution.started") {
        state.executionStartedAt = created
        state.executionEndedAt = null
        state.steps = []
        state.finish = null
        return
      }

      if (type === "session.step.started") {
        state.steps.push({
          assistantMessageID: data.assistantMessageID ?? null,
          model: modelRef(data.model),
          agent: data.agent ?? null,
          started: Number(data.started) || created,
          firstTokenAt: null,
          endedAt: null,
          tokens: null,
          cost: 0,
          finish: null,
        })
        return
      }

      if (type === "session.step.first-token") {
        const step = this.findStep(state, data.assistantMessageID)
        if (step) step.firstTokenAt = created
        return
      }

      if (type === "session.step.ended") {
        const step = this.findStep(state, data.assistantMessageID)
        if (step) {
          step.endedAt = created
          step.tokens = data.tokens ?? null
          step.cost = Number(data.cost) || 0
          step.finish = data.finish ?? null
        }
        return
      }

      if (type === "session.execution.succeeded" || type === "session.execution.failed") {
        this.finish(sessionID, state, created, type === "session.execution.failed" ? "error" : null)
      }
    } catch {
      // Telemetry is best-effort and must never affect a turn.
    }
  }

  findStep(state, messageID) {
    if (messageID) {
      const found = state.steps.find((step) => step.assistantMessageID === messageID)
      if (found) return found
    }
    return state.steps.at(-1) ?? null
  }

  finish(sessionID, state, endedAt, failure) {
    const pending = this.pending.get(sessionID) ?? {}
    const startedAt = Number(state.executionStartedAt) || Number(pending.at) || endedAt
    const executionMs = Math.max(0, endedAt - startedAt)
    let modelMs = 0
    let ttftMs = 0
    const tokens = emptyTokens()
    let cost = 0
    let usedModel = null
    for (const step of state.steps) {
      const stepEnd = Number(step.endedAt) || endedAt
      const stepStart = Number(step.started) || stepEnd
      modelMs += Math.max(0, stepEnd - stepStart)
      if (!ttftMs && step.firstTokenAt) ttftMs = Math.max(0, step.firstTokenAt - stepStart)
      addTokens(tokens, step.tokens)
      cost += Number(step.cost) || 0
      if (step.model) usedModel = step.model
    }
    const record = {
      ts: endedAt,
      host: this.host,
      session: sessionHash(sessionID),
      role: pending.role ?? "root",
      agent: pending.agent ?? "",
      model: pending.chosen ?? usedModel,
      usedModel: usedModel ?? pending.chosen ?? null,
      finish: failure ?? state.finish ?? state.steps.at(-1)?.finish ?? null,
      turnMs: Math.max(0, endedAt - (Number(pending.at) || startedAt)),
      routeMs: Number(pending.routeMs) || 0,
      judgeMs: Number(pending.judgeMs) || 0,
      coreMs: Number(pending.coreMs) || 0,
      switchMs: Number(pending.switchMs) || 0,
      executionMs,
      modelMs,
      toolMs: Math.max(0, executionMs - modelMs),
      ttftMs,
      steps: state.steps.length,
      tokens,
      cost: Math.round(cost * 1_000_000) / 1_000_000,
    }
    try {
      appendTurn(this.host, record, this.env)
    } catch {
      // Disk errors must not break the session.
    }
    this.sessions.delete(sessionID)
    this.pending.delete(sessionID)
  }
}
