import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import tui from "../src/tui.js"
import { readConfig } from "../src/config.js"

function environment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-tui-"))
  process.env.OMLX_ROUTER_CONFIG = path.join(dir, "config.json")
  process.env.OMLX_ROUTER_STATE = path.join(dir, "state")
  return { dir }
}

function fakeContext() {
  let layer
  const messages = []
  const context = {
    location: { directory: "/tmp" },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "ses_1" }) },
      model: { current: () => ({ providerID: "deepseek", id: "deepseek-flash", variant: "default" }) },
      dialog: {
        alert: async ({ title, message }) => messages.push({ kind: "alert", title, message }),
        select: async () => "quality",
      },
      toast: { show: async ({ title, message }) => messages.push({ kind: "toast", title, message }) },
    },
    data: {
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
  return { context, messages, command: () => layer.commands[0] }
}

test("tui exposes the router slash command", () => {
  environment()
  const { context, command } = fakeContext()
  tui.setup(context)
  expect(tui.id).toBe("omlx.router.tui")
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
