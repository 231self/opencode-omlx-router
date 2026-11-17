/**
 * Cost shapes seen in the wild:
 * - `[{ input, output, cache: { read, write }, tier? }]` — OpenCode V2 catalog
 * - `{ input, output, cache_read, cache_write, tiers?, context_over_200k? }` — models.dev
 * - `{ text: { input: { price, cache, overrides }, output: { price, overrides } } }` — V2 client
 * - `{ input: { price }, output: { price } }` — models.dev v1 style
 *
 * Missing prices stay `undefined` so a display can say "unknown" instead of
 * inventing `$0`, and a real zero still reads as free.
 */

function price(value) {
  if (value == null || value === "") return undefined
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (typeof value === "object") {
    if ("price" in value) return price(value.price)
    if ("value" in value) return price(value.value)
    return undefined
  }
  return undefined
}

function tierDefinition(entry) {
  const tier = entry?.tier
  if (tier && typeof tier === "object") {
    const size = Number(tier.size)
    return Number.isFinite(size) && size > 0 ? { type: tier.type ?? "context", size } : null
  }
  // V2 client overrides use `when: { context: { gt: size } }`.
  const threshold = Number(entry?.when?.context?.gt)
  return Number.isFinite(threshold) && threshold > 0 ? { type: "context", size: threshold } : null
}

/**
 * Keep a real zero (a genuinely free field) but treat a zero as "the source
 * had no price" when an external table does have one.
 */
function fill(value, fallback) {
  if (fallback === undefined || fallback === null) return value
  if (value === undefined) return fallback
  if (value === 0 && fallback !== 0) return fallback
  return value
}

function toTier({ input, output, read, write, definition }) {
  return {
    ...(definition ? { tier: definition } : {}),
    input,
    output,
    cache: { read, write },
  }
}

/**
 * Overrides carry either `input`/`output` (models.dev) or a bare `price`
 * (V2 client), so the caller says which side of the bill the override belongs
 * to. They are merged by context size into one tier per size.
 */
function applyOverrides(tiers, overrides) {
  const bySize = new Map()
  for (const { side, entry } of overrides) {
    if (!entry || typeof entry !== "object") continue
    const definition = tierDefinition(entry)
    if (!definition) continue
    const current =
      bySize.get(definition.size) ??
      toTier({
        definition,
        input: undefined,
        output: undefined,
        read: undefined,
        write: undefined,
      })
    const cache = entry.cache && typeof entry.cache === "object" ? entry.cache : {}
    if (side === "output") {
      current.output = price(entry.output ?? entry.price) ?? current.output
    } else {
      current.input = price(entry.input ?? entry.price) ?? current.input
      current.cache.read = price(cache.read ?? entry.cache_read) ?? current.cache.read
      current.cache.write = price(cache.write ?? entry.cache_write) ?? current.cache.write
    }
    bySize.set(definition.size, current)
  }
  tiers.push(...bySize.values())
}

/** One catalog entry may hold several tiers: base prices plus overrides. */
export function tiersOf(entry) {
  if (!entry || typeof entry !== "object") return []
  const nested = ["text", "image", "audio", "video"]
    .map((key) => entry[key])
    .filter((value) => value && typeof value === "object")
  if (nested.length > 0) return nested.flatMap((value) => tiersOf(value))

  const input = entry.input
  const output = entry.output
  const inputObject = input && typeof input === "object" ? input : null
  const outputObject = output && typeof output === "object" ? output : null
  const cache = entry.cache && typeof entry.cache === "object" ? entry.cache : {}

  const tiers = [
    toTier({
      definition: tierDefinition(entry),
      input: price(inputObject ? inputObject.price ?? inputObject.input : input),
      output: price(outputObject ? outputObject.price ?? outputObject.output : output),
      read: price(
        cache.read ??
          entry.cache_read ??
          inputObject?.cache?.read ??
          inputObject?.cache_read,
      ),
      write: price(
        cache.write ??
          entry.cache_write ??
          inputObject?.cache?.write ??
          inputObject?.cache_write,
      ),
    }),
  ]

  const overrides = []
  for (const value of inputObject?.overrides ?? []) overrides.push({ side: "input", entry: value })
  for (const value of outputObject?.overrides ?? []) overrides.push({ side: "output", entry: value })
  applyOverrides(tiers, overrides)

  // models.dev long-context entries are complete price tables, not partial
  // overrides, so they are parsed as tiers of their own.
  for (const value of entry.tiers ?? []) tiers.push(...tiersOf(value))

  return tiers
}

/** Normalise any supported cost shape into catalog tier arrays. */
export function normaliseCost(cost) {
  if (cost == null) return []
  const tiers = []
  if (Array.isArray(cost)) {
    for (const entry of cost) tiers.push(...tiersOf(entry))
  } else if (typeof cost === "object") {
    tiers.push(...tiersOf(cost))
    // models.dev keeps long-context prices in separate fields.
    if (cost.context_over_200k && typeof cost.context_over_200k === "object") {
      tiers.push(
        ...tiersOf({ ...cost.context_over_200k, tier: { type: "context", size: 200000 } }),
      )
    }
  }
  const seen = new Set()
  return tiers.filter((tier) => {
    const key = JSON.stringify(tier)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Where a pool model's displayed prices came from: the host catalog, the
 * models.dev fallback, or nowhere.
 */
export function costSource(catalogTiers, fallbackTiers) {
  const hasPrice = (tiers) =>
    (tiers ?? []).some((tier) => Number(tier?.input) > 0 || Number(tier?.output) > 0)
  const isDefined = (tiers) =>
    (tiers ?? []).some((tier) => tier?.input !== undefined || tier?.output !== undefined)
  if (hasPrice(catalogTiers)) return "catalog"
  if (hasPrice(fallbackTiers)) return "modelsdev"
  if (isDefined(catalogTiers)) return "catalog"
  return "unknown"
}

export function mergeCost(tiers, fallback) {
  const base = Array.isArray(tiers) && tiers.length > 0 ? tiers : []
  if (!Array.isArray(fallback) || fallback.length === 0) return base
  if (base.length === 0) return fallback
  const [first, ...rest] = base
  const external = fallback[0] ?? {}
  return [
    {
      ...first,
      input: fill(first.input, external.input),
      output: fill(first.output, external.output),
      cache: {
        read: fill(first.cache?.read, external.cache?.read),
        write: fill(first.cache?.write, external.cache?.write),
      },
      ...(first.tier ? { tier: first.tier } : {}),
    },
    ...rest,
  ]
}
