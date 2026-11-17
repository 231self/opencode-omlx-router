import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"

import { ABI_VERSION, VERSION } from "../src/version.js"

const bin = path.resolve(import.meta.dir, "../bin/omlx-router.mjs")

function run(...args) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" })
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

test("omlx-router version prints the bare version", () => {
  const result = run("version")
  expect(result.code).toBe(0)
  expect(result.stdout).toBe(VERSION)
})

test("omlx-router version --json reports name, version, and ABI", () => {
  const result = run("version", "--json")
  expect(result.code).toBe(0)
  const info = JSON.parse(result.stdout)
  expect(info.name).toBe("opencode-router")
  expect(info.version).toBe(VERSION)
  expect(info.abi).toBe(ABI_VERSION)
})
