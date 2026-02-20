import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { load, add, remove, list, reorder } from "../src/storage"
import { authJsonPath } from "../src/types"

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-test-"))
  process.env.COPILOT_MULTI_AUTH_DATA_DIR = tmpDir
})

afterEach(async () => {
  delete process.env.COPILOT_MULTI_AUTH_DATA_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("storage", () => {
  test("load returns empty store when no file exists", async () => {
    const store = await load()
    expect(store.version).toBe(1)
    expect(store.accounts).toEqual([])
  })

  test("add creates account and syncs auth.json", async () => {
    const account = {
      id: "test-1",
      label: "personal",
      domain: "github.com",
      token: "gho_test123",
      added_at: Date.now(),
      priority: 0,
    }
    const store = await add(account)
    expect(store.accounts).toHaveLength(1)
    expect(store.accounts[0].id).toBe("test-1")

    const auth = JSON.parse(await fs.readFile(authJsonPath(), "utf-8"))
    expect(auth["github-copilot"].refresh).toBe("gho_test123")
  })

  test("remove deletes account and reindexes priorities", async () => {
    await add({ id: "a", label: "first", domain: "github.com", token: "t1", added_at: 1, priority: 0 })
    await add({ id: "b", label: "second", domain: "github.com", token: "t2", added_at: 2, priority: 1 })
    const store = await remove("a")
    expect(store.accounts).toHaveLength(1)
    expect(store.accounts[0].id).toBe("b")
    expect(store.accounts[0].priority).toBe(0)
  })

  test("reorder changes account priorities", async () => {
    await add({ id: "a", label: "first", domain: "github.com", token: "t1", added_at: 1, priority: 0 })
    await add({ id: "b", label: "second", domain: "github.com", token: "t2", added_at: 2, priority: 1 })
    await reorder(["b", "a"])
    const accounts = await list()
    expect(accounts[0].id).toBe("b")
    expect(accounts[1].id).toBe("a")
  })

  test("add updates existing account by id", async () => {
    await add({ id: "a", label: "first", domain: "github.com", token: "t1", added_at: 1, priority: 0 })
    await add({ id: "a", label: "updated", domain: "github.com", token: "t2", added_at: 2, priority: 0 })
    const accounts = await list()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].label).toBe("updated")
    expect(accounts[0].token).toBe("t2")
  })

  test("enterprise account syncs enterpriseUrl to auth.json", async () => {
    await add({ id: "e1", label: "work", domain: "company.ghe.com", token: "t1", added_at: 1, priority: 0 })
    const auth = JSON.parse(await fs.readFile(authJsonPath(), "utf-8"))
    expect(auth["github-copilot"].enterpriseUrl).toBe("company.ghe.com")
  })
})
