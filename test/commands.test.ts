import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { handleAccounts } from "../src/commands"
import { add, list } from "../src/storage"
import { markRateLimited, resetHealth } from "../src/rotation"

let tmpDir: string
let originalFetch: typeof globalThis.fetch

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-cmd-"))
  process.env.COPILOT_MULTI_AUTH_DATA_DIR = tmpDir
  originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  delete process.env.COPILOT_MULTI_AUTH_DATA_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("handleAccounts", () => {
  test("list: returns 'no accounts' when empty", async () => {
    const result = await handleAccounts("")
    expect(result).toBe("No GitHub Copilot accounts configured.")
  })

  test("list: returns formatted account list", async () => {
    await add({ id: "a", label: "primary", domain: "github.com", token: "t1", added_at: 1, priority: 0 })
    await add({ id: "b", label: "secondary", domain: "github.com", token: "t2", added_at: 2, priority: 1 })
    const result = await handleAccounts("")
    expect(result).toContain("#1")
    expect(result).toContain("#2")
    expect(result).toContain("primary")
    expect(result).toContain("secondary")
    expect(result).toContain("github.com")
    expect(result).toContain("[a]")
    expect(result).toContain("[b]")
  })

  test("list: shows rate limited status when probe detects 429", async () => {
    await add({ id: "a", label: "primary", domain: "github.com", token: "t1", added_at: 1, priority: 0 })
    globalThis.fetch = (async () =>
      new Response("", { status: 429, headers: { "Retry-After": "60" } })
    ) as unknown as typeof fetch
    const result = await handleAccounts("list")
    expect(result).toContain("RATE LIMITED")
  })

  test("list: is the default action", async () => {
    await add({ id: "a", label: "primary", domain: "github.com", token: "t1", added_at: 1, priority: 0 })
    const result1 = await handleAccounts("")
    const result2 = await handleAccounts("list")
    expect(result1).toBe(result2)
  })

  test("remove: removes account by id", async () => {
    await add({ id: "a", label: "primary", domain: "github.com", token: "t1", added_at: 1, priority: 0 })
    await add({ id: "b", label: "secondary", domain: "github.com", token: "t2", added_at: 2, priority: 1 })
    resetHealth("a")
    resetHealth("b")
    const result = await handleAccounts("remove a")
    expect(result).toBe("Removed. 1 account(s) remaining.")
  })

  test("remove: returns error when id is missing", async () => {
    const result = await handleAccounts("remove")
    expect(result).toContain("Error:")
    expect(result).toContain("account ID is required")
  })

  test("reorder: reorders accounts", async () => {
    await add({ id: "a", label: "primary", domain: "github.com", token: "t1", added_at: 1, priority: 0 })
    await add({ id: "b", label: "secondary", domain: "github.com", token: "t2", added_at: 2, priority: 1 })
    resetHealth("a")
    resetHealth("b")
    const result = await handleAccounts("reorder b a")
    expect(result).toContain("reordered successfully")
  })

  test("reorder: returns error when ids are missing", async () => {
    const result = await handleAccounts("reorder")
    expect(result).toContain("Error:")
    expect(result).toContain("account IDs are required")
  })

  test("status: returns detailed health for accounts", async () => {
    await add({ id: "a", label: "primary", domain: "github.com", token: "t1", added_at: 1, priority: 0 })
    resetHealth("a")
    const result = await handleAccounts("status")
    expect(result).toContain("Priority:")
    expect(result).toContain("Health:")
    expect(result).toContain("Rate limited:")
    expect(result).toContain("Consecutive failures:")
    expect(result).toContain("Quota: available")
  })

  test("status: shows quota exhausted when probe detects depleted quotas", async () => {
    await add({ id: "a", label: "primary", domain: "github.com", token: "t1", added_at: 1, priority: 0 })
    resetHealth("a")
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
    const result = await handleAccounts("status")
    expect(result).toContain("Quota: EXHAUSTED")
  })

  test("list: shows quota exhausted tag", async () => {
    await add({ id: "a", label: "primary", domain: "github.com", token: "t1", added_at: 1, priority: 0 })
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          token: "test-token",
          expires_at: 9999999999,
          limited_user_quotas: { chat: 0, completions: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    ) as unknown as typeof fetch
    const result = await handleAccounts("list")
    expect(result).toContain("QUOTA EXHAUSTED")
  })

  test("list: shows error tag on 403", async () => {
    await add({ id: "a", label: "primary", domain: "github.com", token: "t1", added_at: 1, priority: 0 })
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Copilot access denied" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof fetch
    const result = await handleAccounts("list")
    expect(result).toContain("[ERROR 403]")
  })

  test("status: returns 'no accounts' when empty", async () => {
    const result = await handleAccounts("status")
    expect(result).toBe("No accounts configured.")
  })

  test("unknown action: returns usage message", async () => {
    const result = await handleAccounts("foo")
    expect(result).toContain("Usage:")
  })

  test("list: refreshes stale label when probe returns username via /user fallback", async () => {
    await add({ id: "a", label: "account-1234567890", domain: "github.com", token: "t1", added_at: 1, priority: 0 })
    let callCount = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      callCount++
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.toString()
      if (url.includes("copilot_internal")) return new Response("", { status: 404 })
      return new Response(JSON.stringify({ login: "resolveduser" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch
    const result = await handleAccounts("list")
    expect(result).toContain("resolveduser")
    expect(result).not.toContain("account-1234567890")
    const accounts = await list()
    expect(accounts[0].label).toBe("resolveduser")
  })

  test("status: refreshes stale label when probe returns username", async () => {
    await add({ id: "a", label: "old-label", domain: "github.com", token: "t1", added_at: 1, priority: 0 })
    resetHealth("a")
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.toString()
      if (url.includes("copilot_internal")) return new Response("", { status: 404 })
      return new Response(JSON.stringify({ login: "newuser" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch
    const result = await handleAccounts("status")
    expect(result).toContain("newuser")
    expect(result).not.toContain("old-label")
  })
})
