import type { Account } from "./types"
import { pick, markRateLimited, markSuccess, allRateLimited } from "./rotation"

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after")
  if (!header) return undefined
  const seconds = Number(header)
  if (!Number.isNaN(seconds)) return seconds * 1000
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

function detectVision(body: unknown): boolean {
  if (!body || typeof body !== "object") return false
  const b = body as Record<string, unknown>

  if (Array.isArray(b.messages)) {
    return b.messages.some(
      (msg: Record<string, unknown>) =>
        Array.isArray(msg.content) &&
        (msg.content as Record<string, unknown>[]).some(
          (part) => part.type === "image_url" || part.type === "image"
        )
    )
  }

  if (Array.isArray(b.input)) {
    return (b.input as Record<string, unknown>[]).some(
      (item) =>
        Array.isArray(item.content) &&
        (item.content as Record<string, unknown>[]).some(
          (part) => part.type === "input_image"
        )
    )
  }

  return false
}

function detectAgent(body: unknown, url: string): boolean {
  if (!body || typeof body !== "object") return false
  const b = body as Record<string, unknown>

  if (Array.isArray(b.messages) && url.includes("completions")) {
    const last = (b.messages as Record<string, unknown>[])[b.messages.length - 1]
    return last?.role !== "user"
  }

  if (Array.isArray(b.input)) {
    const last = (b.input as Record<string, unknown>[])[b.input.length - 1]
    return last?.role !== "user"
  }

  if (Array.isArray(b.messages)) {
    const last = (b.messages as Record<string, unknown>[])[b.messages.length - 1]
    const hasNonToolCalls =
      Array.isArray(last?.content) &&
      (last.content as Record<string, unknown>[]).some((part) => part.type !== "tool_result")
    return !(last?.role === "user" && hasNonToolCalls)
  }

  return false
}

function buildHeaders(account: Account, body: unknown, url: string, version: string, init?: RequestInit): Record<string, string> {
  const isVision = detectVision(body)
  const isAgent = detectAgent(body, url)

  const headers: Record<string, string> = {
    "x-initiator": isAgent ? "agent" : "user",
    ...(init?.headers as Record<string, string>),
    "User-Agent": `opencode/${version}`,
    Authorization: `Bearer ${account.token}`,
    "Openai-Intent": "conversation-edits",
  }

  if (isVision) headers["Copilot-Vision-Request"] = "true"
  delete headers["x-api-key"]
  delete headers["authorization"]

  return headers
}

function parseBody(init?: RequestInit): unknown {
  if (!init?.body || typeof init.body !== "string") return undefined
  try { return JSON.parse(init.body) } catch { return undefined }
}

export function createFetch(version: string) {
  return async function copilotFetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = request instanceof URL ? request.href : request.toString()
    const body = parseBody(init)
    const tried = new Set<string>()

    let current = await pick()
    if (!current) {
      const recovery = await allRateLimited()
      const msg = recovery
        ? `All accounts rate limited. Earliest recovery: ${new Date(recovery).toISOString()}`
        : "No GitHub Copilot accounts configured"
      return new Response(JSON.stringify({ error: msg }), { status: 429, headers: { "Content-Type": "application/json" } })
    }

    while (current) {
      tried.add(current.account.id)
      const headers = buildHeaders(current.account, body, url, version, init)

      const response = await fetch(request, { ...init, headers })

      if (response.status !== 429) {
        markSuccess(current.account.id)
        return response
      }

      const retryAfter = parseRetryAfter(response)
      markRateLimited(current.account.id, retryAfter)

      current = await pick(tried)
    }

    const recovery = await allRateLimited()
    const msg = recovery
      ? `All accounts rate limited. Earliest recovery: ${new Date(recovery).toISOString()}`
      : "All accounts exhausted"
    return new Response(JSON.stringify({ error: msg }), { status: 429, headers: { "Content-Type": "application/json" } })
  }
}
