// A canonical non-negative integer: "0" or digits with no leading zero.
const CANONICAL_INTEGER = /^(?:0|[1-9]\d*)$/

export function parseAge(value) {
  if (typeof value !== "string") {
    throw new TypeError(`age must be a string, got ${typeof value}`)
  }
  if (!CANONICAL_INTEGER.test(value)) {
    throw new Error(`invalid age: ${JSON.stringify(value)}`)
  }
  const age = Number(value)
  if (!Number.isSafeInteger(age)) {
    throw new Error(`age out of range: ${JSON.stringify(value)}`)
  }
  return age
}
