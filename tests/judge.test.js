import { expect, test } from "bun:test"

import { Judge, JudgeError } from "../src/judge.js"

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function verdictBody(verdict) {
  return {
    choices: [{ message: { content: JSON.stringify(verdict) } }],
  }
}

const goodVerdict = {
  task: "debug",
  complexity: 3,
  needsTools: true,
  needsVision: false,
  contextNeed: "medium",
  reasoningNeed: "high",
  confidence: 0.82,
}

test("auto picks the smallest advertised model", async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.endsWith("/models")) {
      return jsonResponse({ data: [{ id: "Qwen3.8-27B" }, { id: "Qwen3-4B-Instruct" }, { id: "Llama-3.2-1.7B" }] })
    }
    return jsonResponse(verdictBody(goodVerdict))
  }
  const judge = new Judge({ config: { baseURL: "http://127.0.0.1:1234/v1", model: "auto", timeoutMs: 500 }, fetchImpl })
  const result = await judge.verdict({ prompt: "classify", cacheKey: "k1" })
  expect(result.verdict.complexity).toBe(3)
  expect(judge.selected).toBe("Llama-3.2-1.7B")
  expect(calls.length).toBe(2)
})

test("an explicit model skips discovery", async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return jsonResponse(verdictBody(goodVerdict))
  }
  const judge = new Judge({ config: { model: "Qwen3-4B", timeoutMs: 500 }, fetchImpl })
  await judge.verdict({ prompt: "classify" })
  expect(calls.length).toBe(1)
  expect(calls[0]).toContain("/chat/completions")
})

test("cached verdicts avoid a second model call", async () => {
  let chatCalls = 0
  const fetchImpl = async (url) => {
    if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "Qwen3-4B" }] })
    chatCalls += 1
    return jsonResponse(verdictBody(goodVerdict))
  }
  const judge = new Judge({ config: { model: "Qwen3-4B", timeoutMs: 500 }, fetchImpl })
  const first = await judge.verdict({ prompt: "classify", cacheKey: "same" })
  const second = await judge.verdict({ prompt: "classify", cacheKey: "same" })
  expect(first.cached).toBe(false)
  expect(second.cached).toBe(true)
  expect(chatCalls).toBe(1)
})

test("parses fenced JSON and clamps fields", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      choices: [
        {
          message: {
            content: '```json\n{"task":"weird","complexity":9,"needsTools":false,"contextNeed":"huge","reasoningNeed":"max","confidence":3}\n```',
          },
        },
      ],
    })
  const judge = new Judge({ config: { model: "m", timeoutMs: 500 }, fetchImpl })
  const result = await judge.verdict({ prompt: "classify" })
  expect(result.verdict.complexity).toBe(5)
  expect(result.verdict.confidence).toBe(1)
  expect(result.verdict.contextNeed).toBe("medium")
  expect(result.verdict.reasoningNeed).toBe("medium")
})

test("repairs one unparsable answer then fails", async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return jsonResponse({ choices: [{ message: { content: calls === 1 ? "not json" : "still not json" } }] })
  }
  const judge = new Judge({ config: { model: "m", timeoutMs: 500 }, fetchImpl })
  await expect(judge.verdict({ prompt: "classify" })).rejects.toBeInstanceOf(JudgeError)
  expect(calls).toBe(2)
})

test("timeouts surface as JudgeError", async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")))
    })
  const judge = new Judge({ config: { model: "m", timeoutMs: 10 }, fetchImpl })
  await expect(judge.verdict({ prompt: "classify" })).rejects.toThrow(/timeout/)
})
