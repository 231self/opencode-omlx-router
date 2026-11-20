#!/usr/bin/env node
/**
 * Deterministic, offline security gate. No network, no third-party scanner:
 * everything here is a local fact we can verify on every push.
 *
 *  1. no secret-shaped strings in the tree or in the published tarball
 *  2. no npm dependencies, so there is no supply chain to poison
 *  3. no credential-shaped files in the tarball
 *  4. the tarball contains only what package.json says it should
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".lock",
  ".md",
  ".mjs",
  ".rs",
  ".sh",
  ".toml",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
])
const SKIP_DIRS = new Set([".git", ".jj", "node_modules", "target", "dist", "pkgcheck"])
const FORBIDDEN_NAMES = [/^auth\.json$/i, /^secrets?/i, /^id_rsa/i, /^\.env/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.db$/i, /\.sqlite3?$/i]
const ALLOWED_TARBALL_ROOTS = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "config.example.json", "src", "bin", "dist"]

/** Secret shapes worth failing a build over. */
export const SECRET_PATTERNS = [
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{20,}\b/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    "credential assignment",
    /\b(api[_-]?key|apikey|secret|token|password|passwd|authorization)\b\s*[:=]\s*["']([^"']{16,})["']/i,
  ],
]

/** The config format's documented placeholder, not a secret. */
const PLACEHOLDER = /^\{env:[A-Z0-9_]+\}$/i

/** Find secret-shaped strings in one text blob. */
export function scanText(text) {
  const findings = []
  for (const [label, pattern] of SECRET_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
    const regex = new RegExp(pattern.source, flags)
    for (const match of text.matchAll(regex)) {
      const value = match[2] ?? match[0]
      if (PLACEHOLDER.test(value.trim())) continue
      findings.push({ label, sample: `${match[0].slice(0, 24)}…` })
    }
  }
  return findings
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

function isText(file) {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())
}

function scanTree() {
  const findings = []
  for (const file of walk(ROOT)) {
    if (!isText(file)) continue
    const text = fs.readFileSync(file, "utf8")
    for (const finding of scanText(text)) {
      findings.push({ ...finding, file: path.relative(ROOT, file) })
    }
  }
  return findings
}

function packTarball() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-security-"))
  // --ignore-scripts: scanning must not rebuild the world through prepack.
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", dir, "--silent"], {
    cwd: ROOT,
    stdio: "pipe",
  })
  const tarball = fs.readdirSync(dir).find((name) => name.endsWith(".tgz"))
  execFileSync("tar", ["-xzf", tarball, "-C", dir], { cwd: dir, stdio: "pipe" })
  return path.join(dir, "package")
}

function scanTarball() {
  const packed = packTarball()
  const findings = []
  const offenders = []
  for (const file of walk(packed)) {
    const relative = path.relative(packed, file)
    const root = relative.split(path.sep)[0]
    if (!ALLOWED_TARBALL_ROOTS.includes(root)) offenders.push(`unexpected path: ${relative}`)
    if (FORBIDDEN_NAMES.some((pattern) => pattern.test(path.basename(file)))) {
      offenders.push(`credential-shaped file: ${relative}`)
      continue
    }
    if (!isText(file)) continue
    for (const finding of scanText(fs.readFileSync(file, "utf8"))) {
      findings.push({ ...finding, file: relative })
    }
  }
  return { findings, offenders }
}

function checkDependencies() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
  const fields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundledDependencies"]
  return fields.filter((field) => Object.keys(manifest[field] ?? {}).length > 0)
}

function main() {
  const failures = []
  const report = (label, problems) => {
    if (problems.length === 0) {
      console.log(`ok       ${label}`)
      return
    }
    console.log(`FAIL     ${label}`)
    for (const problem of problems) console.log(`         ${problem}`)
    failures.push(label)
  }

  const tree = scanTree()
  report(
    "no secrets in the tree",
    tree.map((f) => `${f.file}: ${f.label} (${f.sample})`),
  )

  const { findings, offenders } = scanTarball()
  report(
    "no secrets in the published tarball",
    findings.map((f) => `${f.file}: ${f.label} (${f.sample})`),
  )
  report("no unexpected files in the tarball", offenders)
  report("no npm dependencies", checkDependencies().map((field) => `package.json has ${field}`))

  if (failures.length > 0) {
    console.log(`\nsecurity check failed: ${failures.join(", ")}`)
    process.exitCode = 1
    return
  }
  console.log("\nsecurity check ok")
}

if (import.meta.main) main()
