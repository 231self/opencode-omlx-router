import { pathToFileURL } from "node:url"
const dir = process.argv[2]
const { parseAge } = await import(pathToFileURL(`${dir}/src/age.js`).href)
if (parseAge("42") !== 42) throw new Error("parseAge(\"42\") should be 42")
for (const value of ["abc", "-3", "1.5"]) {
  let threw = false
  try { parseAge(value) } catch { threw = true }
  if (!threw) throw new Error(`parseAge(${JSON.stringify(value)}) should throw`)
}
