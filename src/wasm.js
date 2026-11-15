import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { ABI_VERSION } from "./version.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_WASM_PATH = path.join(HERE, "..", "dist", "core.wasm")

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class CoreError extends Error {
  constructor(message) {
    super(message)
    this.name = "CoreError"
  }
}

/**
 * Load `dist/core.wasm` and expose route/optimise calls.
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
  for (const name of ["abi_version", "alloc", "dealloc", "result_len", "route", "optimise"]) {
    if (typeof api[name] !== "function") throw new CoreError(`core.wasm missing export ${name}`)
  }
  if (!(api.memory instanceof WebAssembly.Memory)) throw new CoreError("core.wasm missing memory export")

  const abi = api.abi_version()
  if (abi !== ABI_VERSION) throw new CoreError(`core ABI ${abi} does not match adapter ABI ${ABI_VERSION}`)

  function call(name, input) {
    let json
    try {
      json = JSON.stringify(input)
    } catch (error) {
      throw new CoreError(`${name}: request is not serialisable: ${error.message}`)
    }
    const request = encoder.encode(json)
    const ptr = api.alloc(request.length)
    if (!ptr) throw new CoreError(`${name}: core alloc failed`)

    let outPtr
    try {
      new Uint8Array(api.memory.buffer, ptr, request.length).set(request)
      outPtr = api[name](ptr, request.length)
    } finally {
      api.dealloc(ptr, request.length)
    }
    if (!outPtr) throw new CoreError(`${name}: core returned a null result`)

    const length = api.result_len()
    const text = decoder.decode(new Uint8Array(api.memory.buffer, outPtr, length))
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new CoreError(`${name}: core returned invalid JSON: ${error.message}`)
    }
  }

  return {
    abi,
    path: wasmPath,
    route: (input) => call("route", input),
    optimise: (input) => call("optimise", input),
  }
}
