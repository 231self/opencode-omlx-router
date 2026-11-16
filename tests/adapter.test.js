import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import plugin from "../src/index.js"

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-adapter-"))
  process.env.OMLX_ROUTER_CONFIG = path.join(dir, "config.json")
  process.env.OMLX_ROUTER_STATE = path.join(dir, "state")
  return { dir }
}

function fakeContext(options = {}) {
  const hooks = new Map()
  const ctx = {
    options,
    app: { version: "2.3.0" },
    location: { directory: "/tmp" },
    session: {
      hook: async (name, handler) => {
        hooks.set(name, handler)
        return { dispose: async () => hooks.delete(name) }
      },
    },
  }
  return { ctx, hooks }
}

test("setup registers the three session hooks and cleans up", async () => {
  tempEnv()
  const { ctx, hooks } = fakeContext()
  const dispose = await plugin.setup(ctx)
  expect([...hooks.keys()].sort()).toEqual(["compaction", "context", "prompt"])
  expect(typeof dispose).toBe("function")
  await dispose()
  expect(hooks.size).toBe(0)
})

test("setup seeds config from plugin options", async () => {
  const { dir } = tempEnv()
  const { ctx } = fakeContext({ policy: "latency", debug: false })
  await plugin.setup(ctx)
  const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"))
  expect(config.policy).toBe("latency")
})

test("plugin id is stable and the V1 server returns a hook map", async () => {
  tempEnv()
  expect(plugin.id).toBe("omlx-router")
  const hooks = await plugin.server({ directory: "/tmp" })
  expect(hooks).toEqual({})
})
