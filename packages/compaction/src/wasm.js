import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { ABI_VERSION } from "./version.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_WASM_PATH = path.join(HERE, "..", "dist", "core.wasm")

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Mirrors the caps in `core/src/lib.rs`: same budget on both sides of the ABI. */
export const MAX_REQUEST_BYTES = 1024 * 1024
export const MAX_RESULT_BYTES = 1024 * 1024

function trapResult(error) {
  return {
    abi: 0,
    plan: [],
    stats: { beforeTokens: 0, afterTokens: 0, partsPruned: 0, overflow: false },
    reason: "core_trap",
    error: String(error?.message ?? error),
  }
}

export class CoreError extends Error {
  constructor(message) {
    super(message)
    this.name = "CoreError"
  }
}

/**
 * One call across the ABI. A trap, a null result, or an oversized request is
 * reported as an error or a skip — never a broken turn.
 */
export function callApi(api, name, input) {
  let json
  try {
    json = JSON.stringify(input)
  } catch (error) {
    throw new CoreError(`${name}: request is not serialisable: ${error.message}`)
  }
  const request = encoder.encode(json)
  if (request.length > MAX_REQUEST_BYTES) {
    throw new CoreError(`${name}: request of ${request.length} bytes exceeds ${MAX_REQUEST_BYTES}`)
  }
  const ptr = api.alloc(request.length)
  if (!ptr) throw new CoreError(`${name}: core alloc failed`)

  let outPtr
  try {
    new Uint8Array(api.memory.buffer, ptr, request.length).set(request)
    outPtr = api[name](ptr, request.length)
  } catch (error) {
    if (error instanceof CoreError) throw error
    return trapResult(error)
  } finally {
    api.dealloc(ptr, request.length)
  }
  if (!outPtr) throw new CoreError(`${name}: core returned a null result`)

  const length = api.result_len()
  if (length > MAX_RESULT_BYTES) {
    throw new CoreError(`${name}: core returned ${length} bytes, over the ${MAX_RESULT_BYTES} limit`)
  }
  const text = decoder.decode(new Uint8Array(api.memory.buffer, outPtr, length))
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CoreError(`${name}: core returned invalid JSON: ${error.message}`)
  }
}

/**
 * Load `dist/core.wasm` and expose the optimise call.
 *
 * The module has no imports; requests are JSON strings copied through the
 * exported alloc/result buffers. Every call returns plain JSON.
 */
export async function loadCore({ wasmPath = DEFAULT_WASM_PATH } = {}) {
  let bytes
  try {
    bytes = fs.readFileSync(wasmPath)
  } catch (error) {
    throw new CoreError(`cannot read ${wasmPath}: ${error.message}`)
  }

  let instance
  try {
    ;({ instance } = await WebAssembly.instantiate(bytes, {}))
  } catch (error) {
    throw new CoreError(`cannot instantiate ${wasmPath}: ${error.message}`)
  }

  const api = instance.exports
  for (const name of ["abi_version", "alloc", "dealloc", "result_len", "optimise"]) {
    if (typeof api[name] !== "function") throw new CoreError(`core.wasm missing export ${name}`)
  }
  if (!(api.memory instanceof WebAssembly.Memory)) throw new CoreError("core.wasm missing memory export")

  const abi = api.abi_version()
  if (abi !== ABI_VERSION) throw new CoreError(`core ABI ${abi} does not match adapter ABI ${ABI_VERSION}`)

  return {
    abi,
    path: wasmPath,
    optimise: (input) => callApi(api, "optimise", input),
  }
}
