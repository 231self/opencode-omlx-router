import { readConfig } from "./config.js"
import { loadCore } from "./wasm.js"

/**
 * One default export for both hosts:
 * - OpenCode V2 reads `id` and calls `setup(ctx)`.
 * - Kilo calls `server(input)` (V1 plugin API).
 */
export default {
  id: "omlx.router",

  async setup(ctx) {
    const { config, path, seeded, error } = readConfig({ seed: ctx?.options ?? {}, write: true })
    let core = null
    let coreError = null
    try {
      core = await loadCore()
    } catch (cause) {
      coreError = String(cause?.message ?? cause)
    }

    const disposers = []
    const register = async (name, handler) => {
      try {
        disposers.push(await ctx.session.hook(name, handler))
      } catch (cause) {
        coreError ??= `hook ${name}: ${cause?.message ?? cause}`
      }
    }

    // M1 skeleton: hooks are registered so wiring is exercised; M2/M3 replace
    // the bodies. Handlers never log prompt or message text.
    await register("prompt", async () => {})
    await register("context", async () => {})
    await register("compaction", async () => {})

    if (config.debug) {
      console.log("[omlx-router] loaded", {
        version: "0.1.0",
        config: path,
        seeded,
        abi: core?.abi ?? null,
        error: error ?? coreError,
      })
    }

    return () => {
      for (const registration of disposers) {
        try {
          registration?.dispose?.()
        } catch {
          // Cleanup must not mask unload.
        }
      }
    }
  },

  async server(input) {
    const { config } = readConfig({ write: true })
    if (config.debug) console.log("[omlx-router] kilo loaded", { directory: input?.directory ?? null })
    // M5 wires the V1 hooks. Returning an empty hook map keeps Kilo untouched.
    return {}
  },
}
