import { expect, test } from "bun:test"

import { SECRET_PATTERNS, scanText } from "../scripts/security-check.mjs"

// Synthetic fixtures are assembled at runtime on purpose: a scanner that
// exempts its own test file would hide real findings there too.
const openaiKey = ["sk", "proj", "Abc123Xyz_0987654321abcdef"].join("-")
const githubToken = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_")
const privateBlock = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")
const assignedSecret = `const secret = "${"hunter2".repeat(3)}"`

test("the scanner finds credential shapes", () => {
  expect(scanText(`const key = "${openaiKey}"`).map((f) => f.label)).toContain("OpenAI-style key")
  expect(scanText(`const token = "${githubToken}"`).map((f) => f.label)).toContain("GitHub token")
  expect(scanText(assignedSecret).map((f) => f.label)).toContain("credential assignment")
  expect(scanText(`${privateBlock}\nMIIEvQIBADAN`).map((f) => f.label)).toContain("private key block")
})

test("documented env placeholders are not secrets", () => {
  expect(scanText('{"apiKey": "{env:OMLX_ADMIN_API_KEY}", "hfToken": "{env:HF_TOKEN}"}')).toEqual([])
  expect(scanText("apiKey: '{env:MY_LONG_PLACEHOLDER_NAME}'")).toEqual([])
})

test("ordinary source text is clean", () => {
  const source = [
    'import { readConfig } from "./config.js"',
    "export function resolveSecret(value) {",
    "  return value.match(placeholders)",
    "}",
    "// pricing: models.dev then litellm",
  ].join("\n")
  expect(scanText(source)).toEqual([])
  expect(SECRET_PATTERNS.length).toBeGreaterThan(4)
})
