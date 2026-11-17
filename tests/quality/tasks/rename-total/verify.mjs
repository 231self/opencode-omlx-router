import fs from "node:fs"
import { pathToFileURL } from "node:url"
const dir = process.argv[2]
for (const file of ["math.js", "app.js"]) {
  const text = fs.readFileSync(`${dir}/src/${file}`, "utf8")
  if (/\bcalcTotal\b/.test(text)) throw new Error(`${file} still references calcTotal`)
  if (!/\bcalculateTotal\b/.test(text)) throw new Error(`${file} does not reference calculateTotal`)
}
const { calculateTotal } = await import(pathToFileURL(`${dir}/src/math.js`).href)
if (calculateTotal([{ price: 2, qty: 3 }]) !== 6) throw new Error("calculateTotal is wrong")
