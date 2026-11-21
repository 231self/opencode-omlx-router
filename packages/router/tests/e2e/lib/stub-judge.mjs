/**
 * Deterministic oMLX-compatible judge used by the prompt tests.
 *
 * The harness sets one verdict per step; the plugin still exercises the real
 * HTTP client, JSON parsing, repair retry, cache key, and fallback paths.
 */
export function startStubJudge() {
  let verdict = null
  let mode = "json"
  let calls = 0

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: "stub-judge-4B", object: "model", owned_by: "stub" }],
        })
      }
      if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
        calls += 1
        await request.json().catch(() => null)
        const content =
          mode === "malformed"
            ? "This looks like a medium-sized edit task. I would route it to a coding model."
            : JSON.stringify(verdict ?? { task: "edit", complexity: 2 })
        return Response.json({
          id: "chatcmpl-stub",
          object: "chat.completion",
          model: "stub-judge-4B",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    set(nextVerdict) {
      verdict = nextVerdict ?? null
      mode = nextVerdict === "malformed" ? "malformed" : "json"
    },
    reset() {
      calls = 0
    },
    get calls() {
      return calls
    },
    stop() {
      server.stop(true)
    },
  }
}
