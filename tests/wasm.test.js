import { expect, test } from "bun:test"

import { loadCore } from "../src/wasm.js"

test("core loads with ABI 1", async () => {
  const core = await loadCore()
  expect(core.abi).toBe(1)
})

test("route stub returns skip", async () => {
  const core = await loadCore()
  const result = core.route({ abi: 1, kind: "primary" })
  expect(result.abi).toBe(1)
  expect(result.action).toBe("skip")
})

test("route rejects ABI mismatch", async () => {
  const core = await loadCore()
  const result = core.route({ abi: 99 })
  expect(result.action).toBe("skip")
  expect(result.reason).toBe("abi_mismatch")
})

test("optimise stub returns an empty plan", async () => {
  const core = await loadCore()
  const result = core.optimise({ abi: 1, messages: [] })
  expect(result.plan).toEqual([])
  expect(result.stats.overflow).toBe(false)
})

test("repeated calls do not corrupt results", async () => {
  const core = await loadCore()
  for (let index = 0; index < 50; index += 1) {
    const result = core.route({ abi: 1, index })
    expect(result.action).toBe("skip")
  }
})
