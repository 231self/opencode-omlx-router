/** Token estimate matching the Rust core: ASCII ~4 chars/token, CJK ~1.6. */
export function estimateTokens(text) {
  if (!text) return 0
  let ascii = 0
  let wide = 0
  for (const character of String(text)) {
    if (character.codePointAt(0) >= 0x2e80) wide += 1
    else ascii += 1
  }
  return Math.ceil(ascii / 4 + wide / 1.6)
}

export function partTokens(part) {
  if (!part) return 0
  switch (part.type) {
    case "text":
    case "reasoning":
      return estimateTokens(part.text ?? "")
    case "tool": {
      const state = part.state ?? {}
      if (state.status !== "completed") return 0
      return estimateTokens(String(state.output ?? "")) + estimateTokens(JSON.stringify(state.input ?? {}))
    }
    case "file":
    case "image":
      return 1500
    default:
      return 0
  }
}

export function countContextTokens({ system, messages } = {}) {
  let total = 0
  for (const part of system ?? []) total += partTokens(part)
  for (const message of messages ?? []) {
    const parts = message?.parts ?? message?.content
    if (typeof parts === "string") total += estimateTokens(parts)
    else if (Array.isArray(parts)) for (const part of parts) total += partTokens(part)
  }
  return total
}
