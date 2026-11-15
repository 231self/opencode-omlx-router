import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import plugin from "../src/index.js"
import { readDecisions } from "../src/state.js"

const MODELS = [
  {
    id: "deepseek-flash",
    providerID: "deepseek",
    name: "DeepSeek Flash",
    api: { url: "https://api.deepseek.com" },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [{ input: 0.2, output: 0.8, cache: { read: 0.05, write: 0.2 } }],
    limit: { context: 262144, output: 131072 },
    status: "active",
  },
  {
    id: "deepseek-v4-pro",
    providerID: "deepseek",
    name: "DeepSeek Pro",
    api: { url: "https://api.deepseek.com" },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [{ input: 2, output: 8, cache: { read: 0.5, write: 2 } }],
    limit: { context: 262144, output: 131072 },
    status: "active",
  },
]

function environment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-kilo-"))
  const env = {
    OMLX_ROUTER_CONFIG: path.join(dir, "config.json"),
    OMLX_ROUTER_STATE: path.join(dir, "state"),
    OMLX_ROUTER_FAVORITES: path.join(dir, "favorites.json"),
  }
  fs.writeFileSync(
    env.OMLX_ROUTER_CONFIG,
    JSON.stringify({
      pool: {
        source: "list",
        models: ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"],
        requireTools: true,
        minContext: 0,
      },
      judge: { enabled: false },
    }),
  )
  fs.writeFileSync(env.OMLX_ROUTER_FAVORITES, JSON.stringify({ favorite: [], variant: {} }))
  return env
}

function fakeClient({ sessionModel = "deepseek-v4-pro" } = {}) {
  const posts = []
  const api = {
    get: async ({ url }) => {
      if (url === "/api/session/{sessionID}") {
        return {
          data: {
            data: {
              id: "ses_1",
              agent: "code",
              model: { id: sessionModel, providerID: "deepseek", variant: "default" },
            },
          },
        }
      }
      if (url === "/api/model") return { data: { data: MODELS } }
      if (url === "/api/provider") return { data: { data: [{ id: "deepseek", api: { url: "https://api.deepseek.com" } }] } }
      if (url === "/api/agent") return { data: { data: [{ id: "code" }] } }
      return { data: undefined }
    },
    post: async ({ url, body }) => {
      posts.push({ url, body })
      return { data: undefined }
    },
  }
  return { client: { session: { _client: api } }, posts }
}

test("kilo shim routes at the boundary through the SDK transport", async () => {
  const env = environment()
  Object.assign(process.env, env)
  const { client, posts } = fakeClient()
  const hooks = await plugin.server({ client })
  expect(typeof hooks["chat.message"]).toBe("function")

  await hooks["chat.message"](
    { sessionID: "ses_1", agent: "code", model: { providerID: "deepseek", modelID: "deepseek-v4-pro" } },
    { parts: [{ type: "text", text: "implement the parser change" }] },
  )

  expect(posts.length).toBe(1)
  expect(posts[0].url).toBe("/api/session/{sessionID}/model")
  expect(posts[0].body.model.id).toBe("deepseek-flash")

  const decisions = readDecisions("kilo", 5, env)
  expect(decisions.length).toBe(1)
  expect(decisions[0].applied).toBe("boundary")
  expect(decisions[0].chosen).toBe("deepseek/deepseek-flash")
})

test("kilo transform is a safe no-op without an assistant model", async () => {
  const env = environment()
  Object.assign(process.env, env)
  const { client } = fakeClient()
  const hooks = await plugin.server({ client })
  await hooks["experimental.chat.messages.transform"]({}, { messages: [{ info: { role: "user" }, parts: [] }] })
  expect(true).toBe(true)
})

test("kilo title sessions are ignored", async () => {
  const env = environment()
  Object.assign(process.env, env)
  const { client, posts } = fakeClient()
  const hooks = await plugin.server({ client })
  await hooks["chat.message"]({ sessionID: "title-ses_1", agent: "title" }, { parts: [{ type: "text", text: "title" }] })
  expect(posts.length).toBe(0)
})
