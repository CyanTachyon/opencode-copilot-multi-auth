import type { Account } from "./types"
import { normalizeDomain } from "./types"
import { markRateLimited, markSuccess } from "./rotation"

const PROBE_TIMEOUT_MS = 8000

// Copilot client headers required by the token exchange endpoint.
// Without these, the endpoint returns 404.
// See: charmbracelet/catwalk, blacktop/ipsw, SamSaffron/term-llm, acheong08/copilot-proxy
const COPILOT_CLIENT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.26.7",
  "Editor-Version": "vscode/1.96.0",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "Copilot-Integration-Id": "vscode-chat",
  Accept: "application/json",
}

function tokenExchangeURL(domain: string): string {
  if (domain === "github.com") return "https://api.github.com/copilot_internal/v2/token"
  const normalized = normalizeDomain(domain)
  return `https://api.${normalized}/copilot_internal/v2/token`
}

function userApiURL(domain: string): string {
  if (domain === "github.com") return "https://api.github.com/user"
  const normalized = normalizeDomain(domain)
  return `https://${normalized}/api/v3/user`
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after")
  if (!header) return undefined
  const seconds = Number(header)
  if (!Number.isNaN(seconds)) return seconds * 1000
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

export type ProbeResult = {
  id: string
  status: "ok" | "rate_limited" | "quota_exhausted" | "error"
  httpStatus?: number
  retryAfterMs?: number
  /** Reset date for free-tier quota (unix timestamp ms) */
  quotaResetDate?: number
  /** GitHub username resolved from /user API fallback */
  username?: string
  method: "token_exchange" | "user_api"
}

async function tryTokenExchange(account: Account, signal: AbortSignal): Promise<ProbeResult | null> {
  const url = tokenExchangeURL(account.domain)

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `token ${account.token}`,
        ...COPILOT_CLIENT_HEADERS,
      },
      signal,
    })

    // 404 → endpoint not recognized with these headers, fall back to /user
    if (response.status === 404) return null

    // 429 → explicit rate limit
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response)
      markRateLimited(account.id, retryAfterMs)
      return { id: account.id, status: "rate_limited", httpStatus: 429, retryAfterMs, method: "token_exchange" }
    }

    // 200 → token issued; check if free-tier quota is exhausted
    if (response.status === 200) {
      try {
        const body = await response.json() as {
          limited_user_quotas?: { chat?: number; completions?: number }
          limited_user_reset_date?: number | null
        }
        if (body.limited_user_quotas) {
          const { chat, completions } = body.limited_user_quotas
          if ((chat !== undefined && chat <= 0) && (completions !== undefined && completions <= 0)) {
            const resetDate = body.limited_user_reset_date
              ? body.limited_user_reset_date * 1000
              : undefined
            const retryAfterMs = resetDate ? Math.max(0, resetDate - Date.now()) : undefined
            markRateLimited(account.id, retryAfterMs)
            return {
              id: account.id,
              status: "quota_exhausted",
              httpStatus: 200,
              retryAfterMs,
              quotaResetDate: resetDate,
              method: "token_exchange",
            }
          }
        }
      } catch {
        // JSON parse failed — still a 200, treat as ok
      }
      markSuccess(account.id)
      return { id: account.id, status: "ok", httpStatus: 200, method: "token_exchange" }
    }

    // 403 → either rate limited or no access
    if (response.status === 403) {
      try {
        const body = await response.json() as { message?: string }
        if (body.message?.startsWith("API rate limit exceeded")) {
          markRateLimited(account.id)
          return { id: account.id, status: "rate_limited", httpStatus: 403, method: "token_exchange" }
        }
      } catch {
        // JSON parse failed
      }
      return { id: account.id, status: "error", httpStatus: 403, method: "token_exchange" }
    }

    // 401 or other — report error
    return { id: account.id, status: "error", httpStatus: response.status, method: "token_exchange" }
  } catch {
    // Network error → fall back to /user
    return null
  }
}

// Fallback: /user API verifies token and resolves username but can't detect Copilot quota limits
async function tryUserApi(account: Account, signal: AbortSignal): Promise<ProbeResult> {
  const url = userApiURL(account.domain)

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `token ${account.token}`,
        "User-Agent": "OpenCode/1.0",
        Accept: "application/json",
      },
      signal,
    })

    if (response.status === 200) {
      let username: string | undefined
      try {
        const body = await response.json() as { login?: string }
        username = body.login || undefined
      } catch {
        // JSON parse failed
      }
      markSuccess(account.id)
      return { id: account.id, status: "ok", httpStatus: 200, username, method: "user_api" }
    }

    if (response.status === 401) {
      return { id: account.id, status: "error", httpStatus: 401, method: "user_api" }
    }

    if (response.status === 403) {
      // GitHub API rate limit (not Copilot rate limit)
      markRateLimited(account.id)
      return { id: account.id, status: "rate_limited", httpStatus: 403, method: "user_api" }
    }

    return { id: account.id, status: "error", httpStatus: response.status, method: "user_api" }
  } catch {
    return { id: account.id, status: "error", method: "user_api" }
  }
}

export async function probeAccount(account: Account): Promise<ProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

  try {
    // Step 1: Try token exchange with Copilot client headers
    const exchangeResult = await tryTokenExchange(account, controller.signal)
    if (exchangeResult) return exchangeResult

    // Step 2: Fallback to /user API (token exchange returned 404 or network error)
    return await tryUserApi(account, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

export async function probeAll(accounts: Account[]): Promise<Map<string, ProbeResult>> {
  const results = await Promise.allSettled(accounts.map((a) => probeAccount(a)))
  const map = new Map<string, ProbeResult>()
  for (let i = 0; i < accounts.length; i++) {
    const r = results[i]
    if (r.status === "fulfilled") {
      map.set(accounts[i].id, r.value)
    } else {
      map.set(accounts[i].id, { id: accounts[i].id, status: "error", method: "token_exchange" })
    }
  }
  return map
}
