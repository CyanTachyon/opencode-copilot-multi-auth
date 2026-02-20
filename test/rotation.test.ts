import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { pick, markRateLimited, markSuccess, allRateLimited, resetHealth, status } from "../src/rotation"
import { add } from "../src/storage"

const mockAccounts = [
  { id: "a", label: "primary", domain: "github.com", token: "t1", added_at: 1, priority: 0 },
  { id: "b", label: "secondary", domain: "github.com", token: "t2", added_at: 2, priority: 1 },
  { id: "c", label: "tertiary", domain: "github.com", token: "t3", added_at: 3, priority: 2 },
]

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-rot-"))
  process.env.COPILOT_MULTI_AUTH_DATA_DIR = tmpDir
  resetHealth("a")
  resetHealth("b")
  resetHealth("c")
  for (const account of mockAccounts) await add(account)
})

afterEach(async () => {
  delete process.env.COPILOT_MULTI_AUTH_DATA_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("rotation", () => {
  test("pick returns highest priority available account", async () => {
    const result = await pick()
    expect(result?.account.id).toBe("a")
  })

  test("pick skips rate limited accounts", async () => {
    markRateLimited("a", 60_000)
    const result = await pick()
    expect(result?.account.id).toBe("b")
  })

  test("pick respects exclude set", async () => {
    const result = await pick(new Set(["a"]))
    expect(result?.account.id).toBe("b")
  })

  test("pick returns undefined when all excluded", async () => {
    const result = await pick(new Set(["a", "b", "c"]))
    expect(result).toBeUndefined()
  })

  test("markSuccess resets consecutive failures", () => {
    markRateLimited("a", 60_000)
    resetHealth("a")
    markSuccess("a")
    const h = status().get("a")
    expect(h?.consecutive_failures).toBe(0)
    expect(h?.score).toBe(100)
  })

  test("allRateLimited returns earliest recovery time", async () => {
    const now = Date.now()
    markRateLimited("a", 30_000)
    markRateLimited("b", 60_000)
    markRateLimited("c", 90_000)
    const result = await allRateLimited()
    expect(typeof result).toBe("number")
    expect(result as number).toBeGreaterThanOrEqual(now + 30_000)
    expect(result as number).toBeLessThanOrEqual(now + 30_000 + 100)
  })

  test("allRateLimited returns false when account available", async () => {
    markRateLimited("a", 60_000)
    const result = await allRateLimited()
    expect(result).toBe(false)
  })

  test("rate limited account becomes available after expiry", async () => {
    markRateLimited("a", 1)
    await Bun.sleep(5)
    const result = await pick()
    expect(result?.account.id).toBe("a")
  })
})
