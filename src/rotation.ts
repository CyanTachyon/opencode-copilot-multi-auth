import {
  DEFAULT_RETRY_AFTER_MS,
  MAX_RETRY_AFTER_MS,
  type AccountHealth,
  type RotationResult,
} from "./types"
import { list } from "./storage"

const health = new Map<string, AccountHealth>()

function getHealth(id: string): AccountHealth {
  const existing = health.get(id)
  if (existing) return existing
  const fresh: AccountHealth = {
    id,
    score: 100,
    rate_limited_until: 0,
    last_success: 0,
    last_failure: 0,
    consecutive_failures: 0,
  }
  health.set(id, fresh)
  return fresh
}

function isAvailable(h: AccountHealth): boolean {
  if (h.rate_limited_until === 0) return true
  if (Date.now() >= h.rate_limited_until) {
    h.rate_limited_until = 0
    h.score = Math.min(100, h.score + 10)
    return true
  }
  return false
}

export async function pick(excludeIds?: Set<string>): Promise<RotationResult> {
  const accounts = await list()
  for (const account of accounts) {
    if (excludeIds?.has(account.id)) continue
    const h = getHealth(account.id)
    if (isAvailable(h)) return { account, health: h }
  }
  return undefined
}

export function markRateLimited(id: string, retryAfterMs?: number) {
  const h = getHealth(id)
  const delay = Math.min(retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS)
  h.rate_limited_until = Date.now() + delay
  h.score = Math.max(0, h.score - 10)
  h.last_failure = Date.now()
  h.consecutive_failures++
}

export function markSuccess(id: string) {
  const h = getHealth(id)
  h.score = Math.min(100, h.score + 1)
  h.last_success = Date.now()
  h.consecutive_failures = 0
}

export async function allRateLimited(): Promise<number | false> {
  const accounts = await list()
  if (accounts.length === 0) return false
  let earliest = Infinity
  for (const account of accounts) {
    const h = getHealth(account.id)
    if (isAvailable(h)) return false
    if (h.rate_limited_until < earliest) earliest = h.rate_limited_until
  }
  return earliest === Infinity ? false : earliest
}

export function status(): Map<string, AccountHealth> {
  return new Map(health)
}

export function resetHealth(id: string) {
  health.delete(id)
}
