import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { createFetch } from "../src/fetch"
import { resetHealth } from "../src/rotation"
import { add } from "../src/storage"

const mockAccounts = [
  { id: "a", label: "primary", domain: "github.com", token: "token-a", added_at: 1, priority: 0 },
  { id: "b", label: "secondary", domain: "github.com", token: "token-b", added_at: 2, priority: 1 },
]

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-fetch-"))
  process.env.COPILOT_MULTI_AUTH_DATA_DIR = tmpDir
  resetHealth("a")
  resetHealth("b")
  for (const account of mockAccounts) await add(account)
})

afterEach(async () => {
  delete process.env.COPILOT_MULTI_AUTH_DATA_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("fetch wrapper", () => {
  test("uses primary account token in Authorization header", async () => {
    let capturedHeaders: Record<string, string> = {}
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      expect(capturedHeaders["Authorization"]).toBe("Bearer token-a")
      expect(capturedHeaders["User-Agent"]).toBe("opencode/0.1.0")
      expect(capturedHeaders["Openai-Intent"]).toBe("conversation-edits")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("retries with next account on 429", async () => {
    const tokens: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      tokens.push(headers["Authorization"])
      if (tokens.length === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "60" } })
      }
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      const response = await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      expect(response.status).toBe(200)
      expect(tokens).toEqual(["Bearer token-a", "Bearer token-b"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("returns 429 with recovery time when all accounts rate limited", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      return new Response("", { status: 429, headers: { "Retry-After": "60" } })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      const response = await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      expect(response.status).toBe(429)
      const body = await response.json() as { error: string }
      expect(body.error).toContain("All accounts rate limited")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("removes x-api-key and lowercase authorization headers", async () => {
    let capturedHeaders: Record<string, string> = {}
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: { "x-api-key": "should-be-removed", authorization: "should-be-removed" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      expect(capturedHeaders["x-api-key"]).toBeUndefined()
      expect(capturedHeaders["authorization"]).toBeUndefined()
      expect(capturedHeaders["Authorization"]).toBe("Bearer token-a")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
