import { pathToFileURL } from "node:url"
import { deepStrictEqual } from "node:assert"
const dir = process.argv[2]
const { chunk } = await import(pathToFileURL(`${dir}/src/chunk.js`).href)
deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
deepStrictEqual(chunk([], 3), [])
for (const size of [0, -1, 1.5]) {
  let threw = false
  try { chunk([1], size) } catch { threw = true }
  if (!threw) throw new Error(`chunk with size ${size} should throw`)
}
