import { readConfig } from "./config.js"
import { VERSION } from "./version.js"
import { Router, refOf } from "./router.js"
import { refreshQualityIfStale } from "./quality.js"
import { TELEMETRY_EVENTS, Telemetry } from "./telemetry.js"
import { loadCore } from "./wasm.js"

/**
 * One default export for both hosts:
 * - OpenCode V2 reads `id` and calls `setup(ctx)`.
 * - Kilo calls `server(input)` (V1 plugin API).
 */
export default {
  id: "omlx-router",

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

    // Hooks are registered so wiring is exercised. The router owns all logic
    // and never logs prompt or message text.
    const telemetry = config.telemetry?.enabled === false ? null : new Telemetry({ host: "opencode" })
    const router = new Router({
      ctx,
      host: "opencode",
      core,
      telemetry,
      configOptions: ctx?.options ?? {},
    })

    if (config.quality?.source === "lmarena") {
      void refreshQualityIfStale({ config }).catch((cause) => {
        if (config.debug) {
          console.error("[omlx-router] quality refresh failed:", String(cause?.message ?? cause))
        }
      })
    }
    await register("prompt", (event) => router.prompt(event))
    await register("context", (event) => router.context(event))
    await register("compaction", (event) => router.compaction(event))
    await register("retry", (event) => router.retry(event))
    await register("experimental.model.resolve", (event) => router.resolveModel(event))
    try {
      disposers.push(await ctx.tool.hook("execute.after", (event) => router.toolAfter(event)))
    } catch (cause) {
      coreError ??= `tool hook: ${cause?.message ?? cause}`
    }

    if (telemetry && ctx.event?.subscribe) {
      const controller = new AbortController()
      void (async () => {
        try {
          const events = ctx.event.subscribe({ types: TELEMETRY_EVENTS, signal: controller.signal })
          await telemetry.subscribe(events)
        } catch (cause) {
          if (config.debug) console.error("[omlx-router] telemetry stopped:", String(cause?.message ?? cause))
        }
      })()
      disposers.push({ dispose: () => controller.abort() })
    }

    if (config.debug) {
      console.log("[omlx-router] loaded", {
        version: VERSION,
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
    let core = null
    try {
      core = await loadCore()
    } catch (cause) {
      if (config.debug) console.error("[omlx-router] kilo core unavailable:", String(cause?.message ?? cause))
      return {}
    }
    const api = input?.client?.session?._client
    if (!api) return {}

    const call = async (method, url, path, body) => {
      const response = await api[method]({ url, ...(path ? { path } : {}), ...(body ? { body } : {}) })
      if (response?.error) {
        throw new Error(typeof response.error === "string" ? response.error : JSON.stringify(response.error))
      }
      return response?.data
    }

    const readProviders = async () => {
      try {
        if (!input?.client?.config?.providers) return []
        const result = await input.client.config.providers()
        const body = result?.data ?? result
        return Array.isArray(body?.providers) ? body.providers : []
      } catch (cause) {
        if (config.debug) console.error("[omlx-router] kilo providers failed:", String(cause?.message ?? cause))
        return []
      }
    }

    const normalizeModel = (model, provider) => {
      const capabilities = model?.capabilities ?? {}
      const inputSet = capabilities.input
      const outputSet = capabilities.output
      const input = Array.isArray(inputSet)
        ? inputSet
        : Object.entries(inputSet ?? {})
            .filter(([, enabled]) => enabled === true)
            .map(([kind]) => kind)
      const output = Array.isArray(outputSet)
        ? outputSet
        : Object.entries(outputSet ?? {})
            .filter(([, enabled]) => enabled === true)
            .map(([kind]) => kind)
      const cost = Array.isArray(model?.cost) ? model.cost : model?.cost ? [model.cost] : []
      const variants = Array.isArray(model?.variants)
        ? model.variants
        : Object.keys(model?.variants ?? {}).map((id) => ({ id }))
      return {
        ...model,
        providerID: provider.id,
        type: "chat",
        api: model.api ?? provider.api,
        capabilities: {
          tools: Boolean(capabilities.tools ?? capabilities.toolcall),
          input,
          output,
        },
        cost,
        variants,
      }
    }

    const ctx = {
      session: {
        get: async ({ sessionID }) => {
          const body = await call("get", "/api/session/{sessionID}", { sessionID })
          return body?.data ?? body
        },
        switchModel: async ({ sessionID, model }) => {
          await call("post", "/api/session/{sessionID}/model", { sessionID }, { model })
        },
      },
      model: {
        list: async () => {
          const providers = await readProviders()
          const models = []
          for (const provider of providers) {
            for (const model of Object.values(provider?.models ?? {})) {
              if (!model || typeof model !== "object") continue
              models.push(normalizeModel(model, provider))
            }
          }
          if (models.length === 0) {
            const body = await call("get", "/api/model")
            const fallback = body?.data ?? []
            if (config.debug) console.log("[omlx-router] kilo models fallback", fallback.length)
            return fallback
          }
          if (config.debug) {
            const sample = models
              .filter((model) => String(model.providerID).includes("deepseek") || String(model.id).includes("deepseek"))
              .map((model) => `${model.providerID}/${model.id}`)
              .slice(0, 5)
            console.log("[omlx-router] kilo models", models.length, sample)
          }
          return models
        },
      },
      provider: {
        list: async () => {
          const providers = await readProviders()
          return providers.map((provider) => ({
            id: provider.id,
            settings: { baseURL: provider?.api?.url },
            api: provider.api,
          }))
        },
      },
      agent: {
        get: async ({ agentID }) => {
          const body = await call("get", "/api/agent")
          return (body?.data ?? []).find((agent) => agent?.id === agentID)
        },
      },
    }

    const router = new Router({ ctx, host: "kilo", core, appliedMode: "boundary" })

    const assistantModel = (messages) => {
      for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
        const info = messages[index]?.info
        if (info?.role === "assistant" && info?.model?.providerID) return refOf(info.model)
      }
      return null
    }

    return {
      "chat.message": async (event, output) => {
        const sessionID = event?.sessionID
        if (!sessionID || String(sessionID).startsWith("title-")) return
        const text = (output?.parts ?? [])
          .filter((part) => part?.type === "text")
          .map((part) => part.text ?? "")
          .join("\n")
        await router.prompt({ sessionID, prompt: { text, files: [] } })
      },

      "experimental.chat.messages.transform": async (_hook, output) => {
        try {
          const reference = assistantModel(output?.messages)
          if (!reference) return
          const models = await ctx.model.list()
          const found = models.find(
            (model) => model.providerID === reference.providerID && (model.id ?? model.modelID) === reference.id,
          )
          if (found) router.contextMessages({ model: found, messages: output.messages })
        } catch {
          // Transform is best-effort in Kilo.
        }
      },

      "tool.execute.after": async (hookInput, hookOutput) => {
        if (!hookInput?.sessionID) return
        const failed = Boolean(hookOutput?.error)
        router.toolAfter({
          sessionID: hookInput.sessionID,
          tool: hookInput.tool,
          status: failed ? "error" : "completed",
        })
      },
    }
  },
}
