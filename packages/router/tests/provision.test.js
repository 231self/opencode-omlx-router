import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  ProvisionError,
  Provisioner,
  adminBase,
  adminKey,
  confirmThenPull,
  detectProvisioning,
  formatBytes,
  judgeAvailability,
  provisionHint,
  summariseModelInfo,
  validateRepo,
} from "../src/provision.js"

function json(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  })
}

const INFO = {
  repo_id: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
  name: "Qwen3 4B",
  params_formatted: "4.0B",
  tags: ["mlx", "license:apache-2.0"],
  files: [
    { name: "config.json", size: 1000 },
    { name: "model.safetensors", size: 2_100_000_000 },
    { name: "tokenizer.json", size: 11_000_000 },
  ],
}

function fakeFetch({ models = ["Qwen3-4B-Instruct-2507-4bit"], tasks = [] } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url)
    calls.push({ url: parsed.toString(), path: parsed.pathname, method: init.method ?? "GET", headers: init.headers, body: init.body })
    if (parsed.pathname === "/admin/api/login") {
      return json({ success: true }, { headers: { "set-cookie": "omlx_admin_session=session123; Path=/; HttpOnly" } })
    }
    if (parsed.pathname === "/admin/api/hf/model-info") return json(INFO)
    if (parsed.pathname === "/admin/api/hf/download") {
      return json({
        success: true,
        task: { task_id: "task1", repo_id: INFO.repo_id, status: "pending", progress: 0, total_size: 0, downloaded_size: 0 },
      })
    }
    if (parsed.pathname === "/admin/api/hf/tasks") return json({ tasks })
    if (parsed.pathname.startsWith("/admin/api/hf/cancel/")) return json({ success: true })
    if (parsed.pathname === "/v1/models") return json({ data: models.map((id) => ({ id })) })
    return json({ error: "not found" }, { status: 404 })
  }
  return { fetchImpl, calls }
}

function config(overrides = {}) {
  return {
    judge: {
      baseURL: "http://omlx.test/v1",
      model: "auto",
      apiKey: "",
      provision: {
        enabled: true,
        repo: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
        adminApiKey: "admin-key",
        readSettingsKey: false,
        hfToken: "",
        allowNonMlx: false,
      },
      ...overrides,
    },
  }
}

test("adminBase strips /v1 and appends /admin", () => {
  expect(adminBase({ judge: { baseURL: "http://127.0.0.1:1234/v1" } })).toBe("http://127.0.0.1:1234/admin")
  expect(adminBase({ judge: { baseURL: "http://127.0.0.1:1234/v1/" } })).toBe("http://127.0.0.1:1234/admin")
  expect(adminBase({ judge: { baseURL: "http://127.0.0.1:1234" } })).toBe("http://127.0.0.1:1234/admin")
})

test("auto provisioning recognises llama.cpp and returns a setup hint", async () => {
  const fetchImpl = async () => json({ error: "not found" }, { status: 404 })
  const result = await detectProvisioning({ config: config(), fetchImpl })
  expect(result.supported).toBe(false)
  expect(result.backend).toBe("openai-compatible")
  expect(provisionHint(config())).toContain("llama-server")
  expect(provisionHint(config())).toContain("judge.baseURL")
})

test("auto provisioning treats an admin 401 as oMLX", async () => {
  const fetchImpl = async () => json({ error: "unauthorized" }, { status: 401 })
  const result = await detectProvisioning({ config: config(), fetchImpl })
  expect(result.supported).toBe(true)
  expect(result.backend).toBe("omlx")
})

test("backend none disables downloads without probing", async () => {
  let probed = false
  const fetchImpl = async () => {
    probed = true
    return json({}, { status: 404 })
  }
  const cfg = config()
  cfg.judge.provision.backend = "none"
  const result = await detectProvisioning({ config: cfg, fetchImpl })
  expect(result.supported).toBe(false)
  expect(result.backend).toBe("none")
  expect(probed).toBe(false)
})

test("adminKey prefers config and can fall back to oMLX settings", () => {
  expect(adminKey(config(), {}).key).toBe("admin-key")

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-key-"))
  const settings = path.join(dir, "settings.json")
  fs.writeFileSync(settings, JSON.stringify({ auth: { api_key: "settings-key" } }))
  const env = { OMLX_ROUTER_OMLX_SETTINGS: settings }
  const fallback = config()
  fallback.judge.provision.adminApiKey = "{env:MISSING_ADMIN_KEY}"
  fallback.judge.provision.readSettingsKey = true
  expect(adminKey(fallback, env)).toEqual({ key: "settings-key", source: "settings" })

  const blocked = config()
  blocked.judge.provision.adminApiKey = ""
  expect(() => adminKey(blocked, env)).toThrow(ProvisionError)
})

test("login cookie is reused for admin calls", async () => {
  const { fetchImpl, calls } = fakeFetch()
  const provision = new Provisioner({ config: config(), fetchImpl, env: {} })
  const info = await provision.modelInfo(INFO.repo_id)
  expect(info.repo_id).toBe(INFO.repo_id)
  const login = calls.find((call) => call.path === "/admin/api/login")
  expect(login.body).toContain("admin-key")
  const infoCall = calls.find((call) => call.path === "/admin/api/hf/model-info")
  expect(infoCall.headers.cookie).toBe("omlx_admin_session=session123")
})

test("download and tasks carry the admin session", async () => {
  const { fetchImpl, calls } = fakeFetch({ tasks: [{ task_id: "task1", repo_id: INFO.repo_id, status: "completed" }] })
  const provision = new Provisioner({ config: config(), fetchImpl, env: {} })
  const task = await provision.startDownload(INFO.repo_id)
  expect(task.task_id).toBe("task1")
  const download = calls.find((call) => call.path === "/admin/api/hf/download")
  expect(download.method).toBe("POST")
  expect(JSON.parse(download.body)).toEqual({ repo_id: INFO.repo_id, hf_token: "" })
  const tasks = await provision.tasks()
  expect(tasks[0].status).toBe("completed")
  await provision.cancel("task1")
  expect(calls.some((call) => call.path === "/admin/api/hf/cancel/task1")).toBe(true)
})

test("waitFor reports progress and returns the terminal task", async () => {
  const provision = new Provisioner({ config: config(), fetchImpl: fakeFetch().fetchImpl, env: {} })
  const sequence = [
    { task_id: "task1", repo_id: INFO.repo_id, status: "downloading", downloaded_size: 10, total_size: 20 },
    { task_id: "task1", repo_id: INFO.repo_id, status: "completed", downloaded_size: 20, total_size: 20 },
  ]
  let index = 0
  provision.tasks = async () => [sequence[Math.min(index++, sequence.length - 1)]]
  provision.sleep = async () => {}
  const seen = []
  const task = await provision.waitFor("task1", { onProgress: (entry) => seen.push(entry.status) })
  expect(task.status).toBe("completed")
  expect(seen).toEqual(["downloading", "completed"])
})

test("consent gates the download", async () => {
  const { fetchImpl, calls } = fakeFetch()
  const provision = new Provisioner({ config: config(), fetchImpl, env: {} })
  const rejected = await confirmThenPull({ provision, confirm: async () => false })
  expect(rejected.approved).toBe(false)
  expect(calls.some((call) => call.path === "/admin/api/hf/download")).toBe(false)

  const accepted = await confirmThenPull({ provision, confirm: async () => true })
  expect(accepted.approved).toBe(true)
  expect(accepted.task.task_id).toBe("task1")
  expect(calls.filter((call) => call.path === "/admin/api/hf/download").length).toBe(1)
})

test("non-MLX repositories need an explicit override", async () => {
  const { fetchImpl } = fakeFetch()
  const provision = new Provisioner({ config: config(), fetchImpl, env: {} })
  provision.modelInfo = async () => ({ repo_id: "acme/not-mlx", files: [{ name: "README.md", size: 10 }], tags: [] })
  await expect(confirmThenPull({ provision, confirm: async () => true })).rejects.toThrow(/does not look like an MLX model/)
})

test("judge availability prefers a small model and flags large-only installs", async () => {
  const small = await judgeAvailability({ config: config(), fetchImpl: fakeFetch().fetchImpl, env: {} })
  expect(small.available).toBe(true)
  expect(small.suitable).toBe(true)
  expect(small.selected).toBe("Qwen3-4B-Instruct-2507-4bit")

  const large = await judgeAvailability({
    config: config(),
    fetchImpl: fakeFetch({ models: ["Qwen3.8-27B-MLX-4bit"] }).fetchImpl,
    env: {},
  })
  expect(large.available).toBe(true)
  expect(large.suitable).toBe(false)

  const explicit = await judgeAvailability({
    config: config({ model: "Qwen3.8-27B-MLX-4bit" }),
    fetchImpl: fakeFetch({ models: ["Qwen3.8-27B-MLX-4bit"] }).fetchImpl,
    env: {},
  })
  expect(explicit.suitable).toBe(true)
})

test("repo validation, summaries, and byte formatting", () => {
  expect(validateRepo("mlx-community/Qwen3-4B")).toBe("mlx-community/Qwen3-4B")
  expect(() => validateRepo("../evil")).toThrow(ProvisionError)
  const summary = summariseModelInfo(INFO)
  expect(summary.mlx).toBe(true)
  expect(summary.license).toBe("apache-2.0")
  expect(summary.weightsFormatted).toBe("2.0 GB")
  expect(summary.sizeBytes).toBeGreaterThan(summary.weightsBytes)
  expect(formatBytes(0)).toBe("0 B")
  expect(formatBytes(1024)).toBe("1.0 KB")
})
