import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
const dir = process.argv[2]
const url = pathToFileURL(`${dir}/src/config.js`).href
const run = (env) => spawnSync(process.execPath, ["--input-type=module", "-e", `const {port}=await import(${JSON.stringify(url)}); console.log(port)`], { encoding: "utf8", env })
const configured = run({ ...process.env, PORT: "8080" })
if (configured.stdout.trim() !== "8080") throw new Error(`PORT=8080 produced ${configured.stdout.trim()}`)
const fallback = run({ ...process.env, PORT: "" })
if (fallback.stdout.trim() !== "3000") throw new Error(`empty PORT produced ${fallback.stdout.trim()}`)
