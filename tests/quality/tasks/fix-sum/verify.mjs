import { pathToFileURL } from "node:url"
const dir = process.argv[2]
const { sum } = await import(pathToFileURL(`${dir}/src/sum.js`).href)
const checks = [[2, 3, 5], [-1, 1, 0], [0, 0, 0]]
for (const [a, b, expected] of checks) {
  const actual = sum(a, b)
  if (actual !== expected) throw new Error(`sum(${a}, ${b}) = ${actual}, expected ${expected}`)
}
