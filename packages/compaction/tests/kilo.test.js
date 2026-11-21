import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import plugin from "../src/index.js"

const MODELS = [
  {
    id: "deepseek-flash",
    providerID: "deepseek",
    name: "DeepSeek Flash",
    api: { url: "https://api.deepseek.com" },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [{ input: 0.2, output: 0.8, cache: { read: 0.05, write: 0.2 } }],
    // A small budget so the oversized tool output must be pruned.
    limit: { context: 20000, output: 8192 },
    status: "active",
  },
]

function environment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-compaction-kilo-"))
  const env = {
    OMLX_ROUTER_CONFIG: path.join(dir, "config.json"),
    OMLX_ROUTER_STATE: path.join(dir, "state"),
    OMLX_ROUTER_FAVORITES: path.join(dir, "favorites.json"),
  }
  fs.writeFileSync(env.OMLX_ROUTER_CONFIG, JSON.stringify({}))
  return env
}

function fakeClient() {
  const api = {
    get: async ({ url }) => {
      if (url === "/api/model") return { data: { data: MODELS } }
      return { data: undefined }
    },
    post: async () => ({ data: undefined }),
  }
  return { client: { session: { _client: api } } }
}

test("kilo transform is a safe no-op without an assistant model", async () => {
  Object.assign(process.env, environment())
  const { client } = fakeClient()
  const hooks = await plugin.server({ client })
  await hooks["experimental.chat.messages.transform"]({}, { messages: [{ info: { role: "user" }, parts: [] }] })
  expect(true).toBe(true)
})

test("kilo transform applies the optimiser plan through the real core", async () => {
  Object.assign(process.env, environment())
  const { client } = fakeClient()
  const hooks = await plugin.server({ client })
  const messages = [
    {
      info: { role: "assistant", model: { providerID: "deepseek", id: "deepseek-flash" } },
      parts: [{ type: "tool", tool: "read", state: { status: "completed", output: "x".repeat(400_000) } }],
    },
    // Recent turns are protected from pruning; pad so the oversized output
    // is eligible.
    { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
    { info: { role: "user" }, parts: [{ type: "text", text: "again" }] },
  ]
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  // The core plans a truncate for the oversized tool output and the transform
  // applies it in place.
  expect(messages[0].parts[0].state.output.length).toBeLessThan(400_000)
  expect(messages[0].parts[0].state.output).toContain("truncated")
})
