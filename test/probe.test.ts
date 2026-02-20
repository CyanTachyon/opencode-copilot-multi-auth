import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { probeAccount, probeAll } from "../src/probe"
import { resetHealth, status } from "../src/rotation"
import { add } from "../src/storage"
import type { Account } from "../src/types"

const account: Account = { id: "a", label: "primary", domain: "github.com", token: "tok-a", added_at: 1, priority: 0 }
const enterprise: Account = { id: "e", label: "enterprise", domain: "ghe.corp.com", token: "tok-e", added_at: 2, priority: 1 }

let tmpDir: string
let originalFetch: typeof globalThis.fetch

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-probe-"))
  process.env.COPILOT_MULTI_AUTH_DATA_DIR = tmpDir
  originalFetch = globalThis.fetch
  resetHealth("a")
  resetHealth("e")
  await add(account)
  await add(enterprise)
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  delete process.env.COPILOT_MULTI_AUTH_DATA_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("probeAccount — token exchange success", () => {
  test("returns ok and marks success on 200", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch
    const result = await probeAccount(account)
    expect(result.status).toBe("ok")
    expect(result.httpStatus).toBe(200)
    const h = status().get("a")
    expect(h?.consecutive_failures).toBe(0)
  })

  test("returns rate_limited and marks rate limited on 429", async () => {
    globalThis.fetch = (async () =>
      new Response("", { status: 429, headers: { "Retry-After": "120" } })
    ) as unknown as typeof fetch
    const result = await probeAccount(account)
    expect(result.status).toBe("rate_limited")
    expect(result.httpStatus).toBe(429)
    expect(result.retryAfterMs).toBe(120_000)
    const h = status().get("a")
    expect(h!.rate_limited_until).toBeGreaterThan(Date.now())
    expect(h!.consecutive_failures).toBe(1)
  })

  test("returns error on 401 (token invalid)", async () => {
    globalThis.fetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch
    const result = await probeAccount(account)
    expect(result.status).toBe("error")
    expect(result.httpStatus).toBe(401)
  })

  test("returns rate_limited on 403 with 'API rate limit exceeded' message", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "API rate limit exceeded for user ID 12345." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof fetch
    const result = await probeAccount(account)
    expect(result.status).toBe("rate_limited")
    expect(result.httpStatus).toBe(403)
    const h = status().get("a")
    expect(h!.rate_limited_until).toBeGreaterThan(Date.now())
  })

  test("returns error on 403 without rate limit message (no subscription)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Copilot access denied" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof fetch
    const result = await probeAccount(account)
    expect(result.status).toBe("error")
    expect(result.httpStatus).toBe(403)
  })

  test("returns quota_exhausted on 200 with depleted limited_user_quotas", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          token: "test-token",
          expires_at: 9999999999,
          limited_user_quotas: { chat: 0, completions: 0 },
          limited_user_reset_date: Math.floor(Date.now() / 1000) + 86400,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    ) as unknown as typeof fetch
    const result = await probeAccount(account)
    expect(result.status).toBe("quota_exhausted")
    expect(result.httpStatus).toBe(200)
    expect(result.quotaResetDate).toBeGreaterThan(Date.now())
    const h = status().get("a")
    expect(h!.rate_limited_until).toBeGreaterThan(Date.now())
  })

  test("returns ok on 200 with available limited_user_quotas", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          token: "test-token",
          expires_at: 9999999999,
          limited_user_quotas: { chat: 50, completions: 100 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    ) as unknown as typeof fetch
    const result = await probeAccount(account)
    expect(result.status).toBe("ok")
    expect(result.httpStatus).toBe(200)
  })

  test("sends Copilot client headers", async () => {
    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    await probeAccount(account)
    expect(capturedHeaders["Authorization"]).toBe("token tok-a")
    expect(capturedHeaders["User-Agent"]).toBe("GitHubCopilotChat/0.26.7")
    expect(capturedHeaders["Editor-Version"]).toBe("vscode/1.96.0")
    expect(capturedHeaders["Copilot-Integration-Id"]).toBe("vscode-chat")
  })

  test("uses correct URL for github.com", async () => {
    let capturedUrl = ""
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.toString()
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    await probeAccount(account)
    expect(capturedUrl).toBe("https://api.github.com/copilot_internal/v2/token")
  })

  test("uses correct URL for enterprise domain", async () => {
    let capturedUrl = ""
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.toString()
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    await probeAccount(enterprise)
    expect(capturedUrl).toBe("https://api.ghe.corp.com/copilot_internal/v2/token")
  })
})

describe("probeAccount — fallback to /user API", () => {
  test("falls back to /user on 404 and returns ok with username", async () => {
    let callCount = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      callCount++
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.toString()
      if (url.includes("copilot_internal")) {
        return new Response("", { status: 404 })
      }
      return new Response(JSON.stringify({ login: "testuser" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch
    const result = await probeAccount(account)
    expect(result.status).toBe("ok")
    expect(result.username).toBe("testuser")
    expect(callCount).toBe(2)
  })

  test("falls back to /user on network error", async () => {
    let callCount = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      callCount++
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.toString()
      if (url.includes("copilot_internal")) {
        throw new Error("connection refused")
      }
      return new Response(JSON.stringify({ login: "fallbackuser" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch
    const result = await probeAccount(account)
    expect(result.status).toBe("ok")
    expect(result.username).toBe("fallbackuser")
    expect(callCount).toBe(2)
  })

  test("fallback /user uses correct URL for github.com", async () => {
    const capturedUrls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.toString()
      capturedUrls.push(url)
      if (url.includes("copilot_internal")) return new Response("", { status: 404 })
      return new Response(JSON.stringify({ login: "user1" }), { status: 200 })
    }) as unknown as typeof fetch
    await probeAccount(account)
    expect(capturedUrls[1]).toBe("https://api.github.com/user")
  })

  test("fallback /user uses correct URL for enterprise", async () => {
    const capturedUrls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.toString()
      capturedUrls.push(url)
      if (url.includes("copilot_internal")) return new Response("", { status: 404 })
      return new Response(JSON.stringify({ login: "user1" }), { status: 200 })
    }) as unknown as typeof fetch
    await probeAccount(enterprise)
    expect(capturedUrls[1]).toBe("https://ghe.corp.com/api/v3/user")
  })

  test("fallback /user 401 returns error", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.toString()
      if (url.includes("copilot_internal")) return new Response("", { status: 404 })
      return new Response("", { status: 401 })
    }) as unknown as typeof fetch
    const result = await probeAccount(account)
    expect(result.status).toBe("error")
    expect(result.httpStatus).toBe(401)
  })

  test("fallback /user 403 marks rate limited", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.toString()
      if (url.includes("copilot_internal")) return new Response("", { status: 404 })
      return new Response("", { status: 403 })
    }) as unknown as typeof fetch
    const result = await probeAccount(account)
    expect(result.status).toBe("rate_limited")
    expect(result.httpStatus).toBe(403)
  })

  test("returns error when both token exchange and /user fail with network error", async () => {
    globalThis.fetch = (async () => { throw new Error("network down") }) as unknown as typeof fetch
    const result = await probeAccount(account)
    expect(result.status).toBe("error")
    expect(result.httpStatus).toBeUndefined()
  })
})

describe("probeAll", () => {
  test("probes all accounts in parallel", async () => {
    const probed: string[] = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      probed.push(headers["Authorization"])
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    const results = await probeAll([account, enterprise])
    expect(results.size).toBe(2)
    expect(results.get("a")?.status).toBe("ok")
    expect(results.get("e")?.status).toBe("ok")
    expect(probed).toContain("token tok-a")
    expect(probed).toContain("token tok-e")
  })

  test("handles mixed results (one ok, one rate limited)", async () => {
    let callCount = 0
    globalThis.fetch = (async () => {
      callCount++
      if (callCount === 1) return new Response("{}", { status: 200 })
      return new Response("", { status: 429 })
    }) as unknown as typeof fetch
    const results = await probeAll([account, enterprise])
    const statuses = [results.get("a")?.status, results.get("e")?.status].sort()
    expect(statuses).toContain("ok")
    expect(statuses).toContain("rate_limited")
  })

  test("returns empty map for empty accounts", async () => {
    const results = await probeAll([])
    expect(results.size).toBe(0)
  })
})
