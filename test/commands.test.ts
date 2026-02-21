import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { handleAccounts } from "../src/commands"
import { add } from "../src/storage"
import { markRateLimited, markSuccess, resetHealth } from "../src/rotation"

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-cmd-"))
  process.env.COPILOT_MULTI_AUTH_DATA_DIR = tmpDir
  resetHealth("alice")
  resetHealth("bob")
})

afterEach(async () => {
  delete process.env.COPILOT_MULTI_AUTH_DATA_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("handleAccounts", () => {
  describe("list", () => {
    test("no accounts", async () => {
      const result = await handleAccounts("")
      expect(result).toBe("No GitHub Copilot accounts configured.")
    })

    test("shows formatted accounts with UNKNOWN tag when unused", async () => {
      await add({ id: "alice", label: "alice", domain: "github.com", token: "t1", added_at: 0, priority: 0 })
      await add({ id: "bob", label: "bob", domain: "github.com", token: "t2", added_at: 0, priority: 1 })
      const result = await handleAccounts("")
      expect(result).toContain("alice")
      expect(result).toContain("bob")
      expect(result).toContain("[UNKNOWN]")
      expect(result).toContain("#1")
      expect(result).toContain("#2")
      expect(result).toContain("github.com")
    })

    test("shows RATE LIMITED tag when rate limited", async () => {
      await add({ id: "alice", label: "alice", domain: "github.com", token: "t1", added_at: 0, priority: 0 })
      await add({ id: "bob", label: "bob", domain: "github.com", token: "t2", added_at: 0, priority: 1 })
      markRateLimited("alice")
      const result = await handleAccounts("list")
      expect(result).toContain("[RATE LIMITED until")
      expect(result).toContain("alice")
      const lines = result.split("\n")
      const bobLine = lines.find(l => l.includes("bob")) || ""
      expect(bobLine).toContain("[UNKNOWN]")
    })

    test("no tag when account used and healthy", async () => {
      await add({ id: "alice", label: "alice", domain: "github.com", token: "t1", added_at: 0, priority: 0 })
      await add({ id: "bob", label: "bob", domain: "github.com", token: "t2", added_at: 0, priority: 1 })
      markSuccess("alice")
      const result = await handleAccounts("")
      const lines = result.split("\n")
      const aliceLine = lines.find(l => l.includes("alice")) || ""
      expect(aliceLine).not.toContain("[UNKNOWN]")
      expect(aliceLine).not.toContain("[RATE LIMITED")
      const bobLine = lines.find(l => l.includes("bob")) || ""
      expect(bobLine).toContain("[UNKNOWN]")
    })

    test("default action", async () => {
      await add({ id: "alice", label: "alice", domain: "github.com", token: "t1", added_at: 0, priority: 0 })
      const result1 = await handleAccounts("")
      const result2 = await handleAccounts("list")
      expect(result1).toBe(result2)
    })
  })

  describe("remove", () => {
    test("by username", async () => {
      await add({ id: "alice", label: "alice", domain: "github.com", token: "t1", added_at: 0, priority: 0 })
      await add({ id: "bob", label: "bob", domain: "github.com", token: "t2", added_at: 0, priority: 1 })
      const result = await handleAccounts("remove alice")
      expect(result).toContain("Removed alice")
      expect(result).toContain("1 account(s) remaining")
    })

    test("by id prefix", async () => {
      await add({ id: "alice", label: "myuser", domain: "github.com", token: "t1", added_at: 0, priority: 0 })
      const result = await handleAccounts("remove alice")
      expect(result).toContain("Removed myuser")
    })

    test("missing username", async () => {
      const result = await handleAccounts("remove")
      expect(result).toContain("Error:")
      expect(result).toContain("username is required")
    })

    test("unknown username", async () => {
      await add({ id: "alice", label: "alice", domain: "github.com", token: "t1", added_at: 0, priority: 0 })
      const result = await handleAccounts("remove nonexistent")
      expect(result).toContain("Error:")
      expect(result).toContain("no account found")
    })
  })

  describe("reorder", () => {
    test("by usernames", async () => {
      await add({ id: "alice", label: "alice", domain: "github.com", token: "t1", added_at: 0, priority: 0 })
      await add({ id: "bob", label: "bob", domain: "github.com", token: "t2", added_at: 0, priority: 1 })
      const result = await handleAccounts("reorder bob alice")
      expect(result).toContain("reordered successfully")
    })

    test("missing usernames", async () => {
      const result = await handleAccounts("reorder")
      expect(result).toContain("Error:")
      expect(result).toContain("usernames are required")
    })

    test("unknown username", async () => {
      await add({ id: "alice", label: "alice", domain: "github.com", token: "t1", added_at: 0, priority: 0 })
      const result = await handleAccounts("reorder nonexistent")
      expect(result).toContain("Error:")
      expect(result).toContain("no account found")
    })
  })

  describe("status", () => {
    test("no accounts", async () => {
      const result = await handleAccounts("status")
      expect(result).toBe("No accounts configured.")
    })

    test("shows unknown quota for unused accounts", async () => {
      await add({ id: "alice", label: "alice", domain: "github.com", token: "t1", added_at: 0, priority: 0 })
      await add({ id: "bob", label: "bob", domain: "github.com", token: "t2", added_at: 0, priority: 1 })
      const result = await handleAccounts("status")
      expect(result).toContain("Quota: unknown (no requests made yet)")
      expect(result).toContain("alice")
      expect(result).toContain("bob")
    })

    test("shows available quota for used healthy account", async () => {
      await add({ id: "alice", label: "alice", domain: "github.com", token: "t1", added_at: 0, priority: 0 })
      await add({ id: "bob", label: "bob", domain: "github.com", token: "t2", added_at: 0, priority: 1 })
      markSuccess("alice")
      const result = await handleAccounts("status")
      const lines = result.split("\n")
      const aliceStart = lines.findIndex(l => l.startsWith("alice"))
      const aliceSection = lines.slice(aliceStart, aliceStart + 10).join("\n")
      expect(aliceSection).toContain("Quota: available")
      expect(result).toContain("Quota: unknown (no requests made yet)")
    })

    test("shows rate limited quota", async () => {
      await add({ id: "alice", label: "alice", domain: "github.com", token: "t1", added_at: 0, priority: 0 })
      markRateLimited("alice")
      const result = await handleAccounts("status")
      expect(result).toContain("Quota: rate limited until")
      expect(result).toContain("alice")
    })
  })

  describe("unknown action", () => {
    test("returns usage message", async () => {
      const result = await handleAccounts("invalid")
      expect(result).toContain("Usage:")
    })
  })
})
