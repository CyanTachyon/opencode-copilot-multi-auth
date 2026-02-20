import type { Account } from "./types"
import { copilotBaseURL } from "./types"
import { markRateLimited, markSuccess } from "./rotation"

const DEFAULT_BASE_URL = "https://api.githubcopilot.com"
const PROBE_TIMEOUT_MS = 8000

function probeURL(domain: string): string {
  const base = copilotBaseURL(domain) ?? DEFAULT_BASE_URL
  return `${base}/models`
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
  status: "ok" | "rate_limited" | "error"
  httpStatus?: number
  retryAfterMs?: number
}

export async function probeAccount(account: Account): Promise<ProbeResult> {
  const url = probeURL(account.domain)

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${account.token}`,
        "User-Agent": "opencode/probe",
        Accept: "application/json",
      },
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response)
      markRateLimited(account.id, retryAfterMs)
      return { id: account.id, status: "rate_limited", httpStatus: 429, retryAfterMs }
    }

    // Any non-429 response means the account is reachable and not rate-limited.
    // Even 401/403 would mean not rate-limited (token issue, not quota).
    markSuccess(account.id)
    return { id: account.id, status: "ok", httpStatus: response.status }
  } catch {
    // Network error / timeout — don't change health state, we can't tell.
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
