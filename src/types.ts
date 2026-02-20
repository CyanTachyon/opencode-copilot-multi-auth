import path from "path"
import os from "os"

export const CLIENT_ID = "Ov23li8tweQw6odWQebz"
export const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

const DATA_DIR = () => process.env.COPILOT_MULTI_AUTH_DATA_DIR ?? path.join(os.homedir(), ".local", "share", "opencode")
export const accountsPath = () => path.join(DATA_DIR(), "multi-copilot-accounts.json")
export const authJsonPath = () => path.join(DATA_DIR(), "auth.json")

export const RECOVERY_SCORE_PER_HOUR = 2
export const DEFAULT_RETRY_AFTER_MS = 60_000
export const MAX_RETRY_AFTER_MS = 600_000

export const STORE_VERSION = 1

export type Account = {
  id: string
  label: string
  domain: string // "github.com" or enterprise domain
  token: string
  added_at: number
  priority: number // lower = higher priority
}

export type AccountHealth = {
  id: string
  score: number // 100 = healthy, 0 = rate limited
  rate_limited_until: number // timestamp, 0 = not limited
  last_success: number
  last_failure: number
  consecutive_failures: number
}

export type AccountStore = {
  version: number
  accounts: Account[]
}

export type RotationResult = {
  account: Account
  health: AccountHealth
} | undefined

export function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

export function getUrls(domain: string) {
  return {
    DEVICE_CODE_URL: `https://${domain}/login/device/code`,
    ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
  }
}

export function copilotBaseURL(domain: string) {
  if (domain === "github.com") return undefined
  return `https://copilot-api.${normalizeDomain(domain)}`
}
