import { expect, test } from "bun:test"

import { applyPlan, buildOptimiseRequest } from "../src/optimiser.js"

function toolPart(output = "tool output") {
  return {
    type: "tool",
    tool: "read",
    state: { status: "completed", output },
  }
}

function config() {
  return {
    optimiser: {
      reserveOutputTokens: 2048,
      safetyTokens: 128,
      maxToolTokens: 1000,
      keepRecentToolOutputs: 2,
      keepRecentTurns: 1,
    },
  }
}

test("builds a request with tool text and system tokens", () => {
  const request = buildOptimiseRequest({
    model: { providerID: "acme", id: "m", limit: { context: 100000, output: 8192 } },
    config: config(),
    system: [{ type: "text", text: "system prompt" }],
    messages: [
      { info: { role: "assistant" }, parts: [toolPart("abcdefgh")] },
      { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
    ],
  })
  expect(request.model.label).toBe("acme/m")
  expect(request.settings.maxToolTokens).toBe(1000)
  expect(request.messages[0].parts[0]).toMatchObject({ type: "tool", tool: "read" })
  expect(request.messages[0].parts[0].text).toContain("abcdefgh")
  expect(request.systemTokens).toBeGreaterThan(0)
})

test("applies truncate with head, marker, and tail", () => {
  const messages = [{ parts: [toolPart("abcdefghij")] }]
  const applied = applyPlan(messages, [
    { message: 0, part: 0, action: "truncate", headChars: 3, tailChars: 2, marker: "…" },
  ])
  expect(applied).toBe(1)
  expect(messages[0].parts[0].state.output).toBe("abc…ij")
})

test("applies stub with an optional preserved prefix", () => {
  const messages = [{ parts: [toolPart("line one\nline two")] }]
  applyPlan(messages, [
    { message: 0, part: 0, action: "stub", placeholder: "[pruned]", keepHeadChars: 8 },
  ])
  expect(messages[0].parts[0].state.output).toBe("line one\n[pruned]")
})

test("ignores actions for missing parts", () => {
  const messages = [{ parts: [] }]
  const applied = applyPlan(messages, [{ message: 0, part: 0, action: "stub", placeholder: "x" }])
  expect(applied).toBe(0)
})
