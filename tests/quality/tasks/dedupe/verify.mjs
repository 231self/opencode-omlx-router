import fs from "node:fs"
import { pathToFileURL } from "node:url"
const dir = process.argv[2]
const format = fs.readFileSync(`${dir}/src/format.js`, "utf8")
if (!/export function formatName/.test(format)) throw new Error("src/format.js must export formatName")
for (const file of ["users.js", "orders.js"]) {
  const text = fs.readFileSync(`${dir}/src/${file}`, "utf8")
  if (/function formatName/.test(text)) throw new Error(`${file} still defines formatName`)
  if (!/from "\.\/format\.js"/.test(text)) throw new Error(`${file} does not import from ./format.js`)
}
const { userName } = await import(pathToFileURL(`${dir}/src/users.js`).href)
const { orderLabel } = await import(pathToFileURL(`${dir}/src/orders.js`).href)
if (userName({ first: "Ada", last: "Lovelace" }) !== "ada lovelace") throw new Error("userName broke")
if (orderLabel({ first: "Ada", last: "Lovelace" }) !== "Order: Ada Lovelace") throw new Error("orderLabel broke")
