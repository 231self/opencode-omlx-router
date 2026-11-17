import { pathToFileURL } from "node:url"
const dir = process.argv[2]
const { loadValue } = await import(pathToFileURL(`${dir}/src/load.js`).href)
const value = loadValue()
if (value !== 7) throw new Error(`loadValue() returned ${Object.prototype.toString.call(value)}, expected 7`)
