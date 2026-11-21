/**
 * Model-reference semantics shared by the plugins. These define identity for
 * the pin schema in `state.js`: both plugins must agree on what "the same
 * model" means or their pin writes will fight each other.
 */

export function refOf(model) {
  if (!model) return null
  const id = model.id ?? model.modelID
  if (!id || !model.providerID) return null
  return { providerID: model.providerID, id, variant: model.variant ?? "default" }
}

export function sameModel(left, right) {
  if (!left || !right) return false
  return left.providerID === right.providerID && left.id === right.id
}

export function sameModelAndVariant(left, right) {
  if (!sameModel(left, right)) return false
  return (left.variant ?? "default") === (right.variant ?? "default")
}

export function decisionRef(decision) {
  return {
    providerID: decision.providerID,
    id: decision.id,
    variant: decision.variant ?? "default",
  }
}
