import { expect, test } from "bun:test"

import { callApi, loadCore } from "../src/wasm.js"

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

test("optimise returns an empty plan inside budget", async () => {
  const core = await loadCore()
  const result = core.optimise({
    abi: 1,
    model: { limit: { context: 100000, output: 8192 } },
    messages: [],
  })
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

function fakeApi(overrides = {}) {
  return {
    memory: new WebAssembly.Memory({ initial: 1 }),
    alloc: () => 8,
    dealloc: () => {},
    result_len: () => 0,
    route: () => 1,
    optimise: () => 1,
    ...overrides,
  }
}

test("an oversized request is refused before it reaches the core", () => {
  expect(() => callApi(fakeApi(), "route", { abi: 1, blob: "x".repeat(1_500_000) })).toThrow(
    /exceeds 1048576/,
  )
})

test("a core trap degrades to skip instead of breaking the turn", () => {
  const api = fakeApi({
    route: () => {
      throw new WebAssembly.RuntimeError("unreachable")
    },
  })
  const result = callApi(api, "route", { abi: 1 })
  expect(result.action).toBe("skip")
  expect(result.reason).toBe("core_trap")
  expect(result.error).toContain("unreachable")
})

test("a trap during optimise degrades to an empty plan", () => {
  const api = fakeApi({
    optimise: () => {
      throw new WebAssembly.RuntimeError("out of bounds")
    },
  })
  const result = callApi(api, "optimise", { abi: 1 })
  expect(result.plan).toEqual([])
  expect(result.stats.overflow).toBe(false)
  expect(result.reason).toBe("core_trap")
})

test("an oversized result is refused", () => {
  const api = fakeApi({ result_len: () => 2_000_000 })
  expect(() => callApi(api, "route", { abi: 1 })).toThrow(/over the 1048576 limit/)
})
