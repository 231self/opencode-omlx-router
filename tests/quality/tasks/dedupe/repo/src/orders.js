import { formatName } from "./format.js"

export function orderLabel(person) {
  return `Order: ${formatName(person)}`
}
