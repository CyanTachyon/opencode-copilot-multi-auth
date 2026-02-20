import type { Account } from "./types"
import { normalizeDomain } from "./types"
import { markRateLimited, markSuccess } from "./rotation"

const PROBE_TIMEOUT_MS = 8000

/**
 * Probe the Copilot token exchange endpoint to check account health.
 *
 * This endpoint accepts the OAuth token directly and returns:
 *   200 — account is active (check limited_user_quotas for free-tier exhaustion)
 *   401 — OAuth token invalid or expired
 *   403 — rate limited (message starts with "API rate limit exceeded")
 *        OR no Copilot subscription (error_details.notification_id)
 *   429 — HTTP-level rate limit (less common but handled)
 */
function tokenExchangeURL(domain: string): string {
  if (domain === "github.com") return "https://api.github.com/copilot_internal/v2/token"
  const normalized = normalizeDomain(domain)
  return `https://api.${normalized}/copilot_internal/v2/token`
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
}

export async function probeAccount(account: Account): Promise<ProbeResult> {
  const url = tokenExchangeURL(account.domain)

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Token ${account.token}`,
        "User-Agent": "OpenCode/1.0",
        Accept: "application/json",
      },
      signal: controller.signal,
    })

    clearTimeout(timer)

    // HTTP 429 — explicit rate limit
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response)
      markRateLimited(account.id, retryAfterMs)
      return { id: account.id, status: "rate_limited", httpStatus: 429, retryAfterMs }
    }

    // HTTP 200 — token issued; check if free-tier quota is exhausted
    if (response.status === 200) {
      try {
        const body = await response.json() as {
          limited_user_quotas?: { chat?: number; completions?: number }
          limited_user_reset_date?: number | null
        }
        if (body.limited_user_quotas) {
          const { chat, completions } = body.limited_user_quotas
          if ((chat !== undefined && chat <= 0) && (completions !== undefined && completions <= 0)) {
            // Both quotas exhausted — treat as rate limited
            const resetDate = body.limited_user_reset_date
              ? body.limited_user_reset_date * 1000 // convert seconds to ms
              : undefined
            const retryAfterMs = resetDate ? Math.max(0, resetDate - Date.now()) : undefined
            markRateLimited(account.id, retryAfterMs)
            return {
              id: account.id,
              status: "quota_exhausted",
              httpStatus: 200,
              retryAfterMs,
              quotaResetDate: resetDate,
            }
          }
        }
      } catch {
        // JSON parse failed — still a 200, treat as ok
      }
      markSuccess(account.id)
      return { id: account.id, status: "ok", httpStatus: 200 }
    }

    // HTTP 403 — either rate limited or no access
    if (response.status === 403) {
      try {
        const body = await response.json() as { message?: string }
        if (body.message?.startsWith("API rate limit exceeded")) {
          markRateLimited(account.id)
          return { id: account.id, status: "rate_limited", httpStatus: 403 }
        }
      } catch {
        // JSON parse failed
      }
      // 403 but not rate limit — no subscription / access denied
      return { id: account.id, status: "error", httpStatus: 403 }
    }

    // 401 or other — report error without changing health state
    return { id: account.id, status: "error", httpStatus: response.status }
  } catch {
    // Network error / timeout
    return { id: account.id, status: "error" }
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
      map.set(accounts[i].id, { id: accounts[i].id, status: "error" })
    }
  }
  return map
}
