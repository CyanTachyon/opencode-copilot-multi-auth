import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { handleAccounts } from "../src/commands"
import { add } from "../src/storage"
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
  })

  test("status: returns 'no accounts' when empty", async () => {
    const result = await handleAccounts("status")
    expect(result).toBe("No accounts configured.")
  })

  test("unknown action: returns usage message", async () => {
    const result = await handleAccounts("foo")
    expect(result).toContain("Usage:")
  })
})
