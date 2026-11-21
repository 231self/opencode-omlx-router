import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import plugin from "../src/index.js"

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-compaction-adapter-"))
  return {
    OMLX_ROUTER_CONFIG: path.join(dir, "config.json"),
    OMLX_ROUTER_STATE: path.join(dir, "state"),
    OMLX_ROUTER_FAVORITES: path.join(dir, "favorites.json"),
  }
}

function fakeContext() {
  const hooks = new Map()
  const ctx = {
    options: {},
    session: {
      hook: async (name, handler) => {
        hooks.set(name, handler)
        return { dispose: () => hooks.delete(name) }
      },
    },
  }
  return { ctx, hooks }
}

test("setup registers the context hook and cleans up", async () => {
  Object.assign(process.env, tempEnv())
  const { ctx, hooks } = fakeContext()
  const dispose = await plugin.setup(ctx)
  expect([...hooks.keys()]).toEqual(["context"])
  expect(typeof dispose).toBe("function")
  await dispose()
  expect(hooks.size).toBe(0)
})
