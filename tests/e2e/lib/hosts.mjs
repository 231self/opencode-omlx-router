import fs from "node:fs"
import path from "node:path"

export function hostConfig(host, repo, model) {
  if (host === "kilo") {
    return {
      $schema: "https://app.kilo.ai/config.json",
      plugin: [path.join(repo, "src", "index.js")],
      model,
    }
  }
  return {
    $schema: "https://opencode.ai/config.json",
    plugins: [repo],
    model,
    agent: { title: { disable: true } },
  }
}

export function writeHostConfig(host, workspace, repo, model) {
  const file = path.join(workspace, host === "kilo" ? "kilo.jsonc" : "opencode.jsonc")
  fs.writeFileSync(file, `${JSON.stringify(hostConfig(host, repo, model), null, 2)}\n`)
  return file
}

export function hostBinary(host) {
  return host === "kilo" ? "kilo" : "opencode"
}

export function buildArgs(host, { prompt, sessionID, model, agent, auto, title }) {
  const args = host === "kilo" ? ["run", "--format", "json"] : ["run", "--standalone", "--format", "json"]
  if (sessionID) args.push("--session", sessionID)
  if (model) args.push("--model", model)
  if (agent) args.push("--agent", agent)
  if (auto) args.push("--auto")
  if (title) args.push("--title", title)
  args.push(prompt)
  return args
}

export function parseSessionIDs(text) {
  const found = String(text ?? "").match(/ses_[A-Za-z0-9]+/g) ?? []
  return [...new Set(found)]
}

export function makeEnv({ configPath, statePath, favoritesPath }) {
  const env = { ...process.env }
  env.OMLX_ROUTER_CONFIG = configPath
  env.OMLX_ROUTER_STATE = statePath
  if (favoritesPath) env.OMLX_ROUTER_FAVORITES = favoritesPath
  else delete env.OMLX_ROUTER_FAVORITES
  delete env.OMLX_ROUTER_OMLX_SETTINGS
  // The harness may itself be running inside OpenCode. Do not let the child
  // inherit this session's identity, project location, or host markers.
  for (const key of Object.keys(env)) {
    if (/^(OPENCODE|KILO|AI_AGENT)/.test(key)) delete env[key]
  }
  delete env.PWD
  delete env.OLDPWD
  delete env.INIT_CWD
  return env
}

export async function runProcess({ cmd, cwd, env, timeoutMs }) {
  let proc
  try {
    proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" })
  } catch (error) {
    return { code: null, stdout: "", stderr: String(error?.message ?? error), timedOut: false, spawnError: true }
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill("SIGKILL")
    } catch {
      // already gone
    }
  }, timeoutMs)

  let code = null
  try {
    code = await proc.exited
  } catch {
    code = null
  } finally {
    clearTimeout(timer)
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text().catch(() => ""),
    new Response(proc.stderr).text().catch(() => ""),
  ])
  return { code, stdout, stderr, timedOut, spawnError: false }
}

function refOf(model) {
  if (!model) return null
  const id = model.id ?? model.modelID
  if (!id || !model.providerID) return null
  return { providerID: model.providerID, id }
}

/** Normalise the OpenCode and Kilo export shapes into a small model summary. */
export function summariseExport(host, body) {
  const info = body?.info ?? {}
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const assistant = []
  for (const message of messages) {
    if (host === "kilo") {
      const entry = message?.info ?? message
      if (entry?.role !== "assistant") continue
      assistant.push({
        model: refOf({ providerID: entry.providerID, modelID: entry.modelID }),
        agent: entry.agent ?? entry.mode ?? "",
      })
      continue
    }
    if (message?.type !== "assistant") continue
    assistant.push({ model: refOf(message.model), agent: message.agent ?? "" })
  }
  return {
    sessionModel: refOf(info.model),
    assistantModels: assistant.map((entry) => entry.model).filter(Boolean),
    assistantAgents: assistant.map((entry) => entry.agent).filter(Boolean),
    messages: messages.length,
  }
}

export async function exportSession({ host, cwd, env, sessionID }) {
  const bin = hostBinary(host)
  const cmd = host === "kilo" ? [bin, "export", sessionID] : [bin, "session", "export", sessionID]
  const result = await runProcess({ cmd, cwd, env, timeoutMs: 60_000 })
  if (result.code !== 0) {
    throw new Error(`${cmd.join(" ")} failed (exit ${result.code}): ${result.stderr.slice(-500)}`)
  }
  let body
  try {
    body = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`cannot parse ${cmd.join(" ")} output: ${error.message}; ${result.stdout.slice(0, 200)}`)
  }
  return summariseExport(host, body)
}
