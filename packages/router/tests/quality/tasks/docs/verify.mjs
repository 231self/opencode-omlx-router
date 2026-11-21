import fs from "node:fs"
const dir = process.argv[2]
const text = fs.readFileSync(`${dir}/README.md`, "utf8")
if (!text.includes("bun add new-pkg")) throw new Error("README does not contain the new install command")
if (text.includes("npm install old-pkg")) throw new Error("README still contains the old install command")
if (!text.includes("[docs](./docs.md)")) throw new Error("README does not link to ./docs.md")
if (text.includes("missing.md")) throw new Error("README still links to missing.md")
