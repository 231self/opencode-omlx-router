import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import tui from "../src/tui.js"
import { readConfig, saveConfig } from "../src/config.js"
import { appendTurn } from "../src/state.js"

function environment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-tui-"))
  process.env.OMLX_ROUTER_CONFIG = path.join(dir, "config.json")
  process.env.OMLX_ROUTER_STATE = path.join(dir, "state")
  return { dir }
}

function fakeContext() {
  let layer
  const messages = []
  const handlers = {}
  const synced = []
  let confirmAnswer = true
  const context = {
    location: { directory: "/tmp" },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "ses_1" }) },
      model: { current: () => ({ providerID: "deepseek", id: "deepseek-flash", variant: "default" }) },
      dialog: {
        alert: async ({ title, message }) => messages.push({ kind: "alert", title, message }),
        select: async () => "quality",
        confirm: async () => confirmAnswer,
      },
      toast: { show: async ({ title, message }) => messages.push({ kind: "toast", title, message }) },
    },
    data: {
      on: (type, handler) => {
        handlers[type] = handler
        return () => {
          delete handlers[type]
        }
      },
      session: {
        sync: async (sessionID) => {
          synced.push(sessionID)
        },
        invalidate: () => {},
      },
      location: {
        default: () => ({ directory: "/tmp" }),
        model: {
          sync: async () => {},
          list: () => [],
        },
        provider: {
          sync: async () => {},
          list: () => [],
        },
      },
    },
    keymap: {
      layer: (factory) => {
        layer = factory()
      },
    },
  }
  return {
    context,
    messages,
    command: () => layer.commands[0],
    handlers,
    synced,
    setConfirm: (value) => {
      confirmAnswer = value
    },
  }
}

test("tui exposes the router slash command", () => {
  environment()
  const { context, command } = fakeContext()
  tui.setup(context)
  expect(tui.id).toBe("omlx-router.tui")
  expect(command().slash).toEqual({ name: "router", arguments: true })
})

test("/router on and /router policy update the shared config", async () => {
  environment()
  const { context, messages, command } = fakeContext()
  tui.setup(context)

  await command().run("on")
  expect(readConfig({ write: false }).config.enabled).toBe(true)

  await command().run("policy")
  expect(readConfig({ write: false }).config.policy).toBe("quality")
  expect(messages.some((entry) => entry.message.includes("policy"))).toBe(true)
})

test("/router status renders a dialog", async () => {
  environment()
  const { context, messages, command } = fakeContext()
  tui.setup(context)
  await command().run("status")
  const alert = messages.find((entry) => entry.kind === "alert")
  expect(alert.message).toContain("opencode-omlx-router")
  expect(alert.message).toContain("policy")
})

function fakeAdminFetch() {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url)
    calls.push({ path: parsed.pathname, method: init.method ?? "GET" })
    const json = (value, headers = {}) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", ...headers } })
    if (parsed.pathname === "/v1/models") {
      return json({ data: [{ id: "Qwen3.8-27B-MLX-4bit" }] })
    }
    if (parsed.pathname === "/admin/api/login") {
      return json({ success: true }, { "set-cookie": "omlx_admin_session=abc; Path=/" })
    }
    if (parsed.pathname === "/admin/api/hf/model-info") {
      return json({
        repo_id: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
        params_formatted: "4.0B",
        tags: ["mlx", "license:apache-2.0"],
        files: [
          { name: "config.json", size: 1000 },
          { name: "model.safetensors", size: 2_254_857_830 },
        ],
      })
    }
    if (parsed.pathname === "/admin/api/hf/download") {
      return json({ task: { task_id: "t1", repo_id: "mlx-community/Qwen3-4B-Instruct-2507-4bit", status: "pending" } })
    }
    if (parsed.pathname === "/admin/api/hf/tasks") {
      return json({ tasks: [{ task_id: "t1", repo_id: "mlx-community/Qwen3-4B-Instruct-2507-4bit", status: "completed" }] })
    }
    return json({ error: "not found" })
  }
  return { fetchImpl, calls }
}

function provisionConfig() {
  environment()
  const config = readConfig({ write: true }).config
  config.judge.baseURL = "http://omlx.test/v1"
  config.judge.provision.adminApiKey = "admin-key"
  config.judge.provision.readSettingsKey = false
  saveConfig(config)
  return config
}

test("/router judge offers a consented download when only a large model exists", async () => {
  provisionConfig()
  const { context, messages, command } = fakeContext()
  tui.setup(context)
  const fake = fakeAdminFetch()
  const original = globalThis.fetch
  globalThis.fetch = fake.fetchImpl
  try {
    await command().run("judge")
  } finally {
    globalThis.fetch = original
  }
  expect(fake.calls.some((call) => call.path === "/admin/api/hf/model-info")).toBe(true)
  expect(fake.calls.some((call) => call.path === "/admin/api/hf/download" && call.method === "POST")).toBe(true)
  expect(messages.some((entry) => String(entry.message).includes("downloading"))).toBe(true)
})

test("/router judge pull does not download when consent is declined", async () => {
  provisionConfig()
  const { context, command, setConfirm } = fakeContext()
  setConfirm(false)
  tui.setup(context)
  const fake = fakeAdminFetch()
  const original = globalThis.fetch
  globalThis.fetch = fake.fetchImpl
  try {
    await command().run("judge pull")
  } finally {
    globalThis.fetch = original
  }
  expect(fake.calls.some((call) => call.path === "/admin/api/hf/download")).toBe(false)
})

test("/router timing reports local judge vs remote model time", async () => {
  const { dir } = environment()
  appendTurn(
    "opencode",
    {
      ts: Date.now(),
      role: "root",
      usedModel: "deepseek/deepseek-flash",
      turnMs: 10_000,
      routeMs: 1_000,
      judgeMs: 800,
      modelMs: 7_000,
      toolMs: 2_000,
    },
    { OMLX_ROUTER_STATE: path.join(dir, "state") },
  )
  const { context, messages, command } = fakeContext()
  tui.setup(context)
  await command().run("timing")
  const text = messages.map((entry) => String(entry.message)).join("\n")
  expect(text).toContain("local judge 800ms")
  expect(text).toContain("remote model 7.0s")
  expect(text).toContain("turn 10.0s")
})

test("tui refreshes the model and shows a switch toast", async () => {
  environment()
  const { context, messages, handlers, synced } = fakeContext()
  tui.setup(context)
  handlers["session.model.selected"]({
    data: {
      sessionID: "ses_1",
      model: { providerID: "deepseek", id: "deepseek-v4-pro" },
      previous: { providerID: "deepseek", id: "deepseek-flash" },
    },
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(synced).toContain("ses_1")
  expect(messages.some((entry) => String(entry.message).includes("deepseek-v4-pro"))).toBe(true)
})
