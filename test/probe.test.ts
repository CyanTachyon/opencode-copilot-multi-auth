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

describe("probeAccount", () => {
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

  test("returns ok on 401 (token issue, not rate limit)", async () => {
    globalThis.fetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch
    const result = await probeAccount(account)
    expect(result.status).toBe("ok")
    expect(result.httpStatus).toBe(401)
  })

  test("returns error on network failure without changing health", async () => {
    globalThis.fetch = (async () => { throw new Error("network down") }) as unknown as typeof fetch
    const result = await probeAccount(account)
    expect(result.status).toBe("error")
    expect(result.httpStatus).toBeUndefined()
    const h = status().get("a")
    expect(h).toBeUndefined()
  })

  test("uses correct URL for github.com", async () => {
    let capturedUrl = ""
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.toString()
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    await probeAccount(account)
    expect(capturedUrl).toBe("https://api.githubcopilot.com/models")
  })

  test("uses correct URL for enterprise domain", async () => {
    let capturedUrl = ""
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.toString()
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    await probeAccount(enterprise)
    expect(capturedUrl).toBe("https://copilot-api.ghe.corp.com/models")
  })

  test("sends correct Authorization header", async () => {
    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    await probeAccount(account)
    expect(capturedHeaders["Authorization"]).toBe("Bearer tok-a")
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
    expect(probed).toContain("Bearer tok-a")
    expect(probed).toContain("Bearer tok-e")
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
