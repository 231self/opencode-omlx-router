import { normaliseCost } from "./cost.js"

/**
 * Kilo (V1 plugin API) host shim: builds the OpenCode-style `ctx` both
 * plugins use, over Kilo's raw session client. Returns null when the client
 * surface is unavailable; callers treat that as "no Kilo".
 */
export function createKiloContext(input, config) {
  const api = input?.client?.session?._client
  if (!api) return null

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
    const cost = normaliseCost(model?.cost)
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

  return {
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
}
