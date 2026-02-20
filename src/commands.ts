import { list, remove, reorder, add } from "./storage"
import { status, resetHealth } from "./rotation"
import { probeAll, type ProbeResult } from "./probe"
import type { Account } from "./types"

const ACTIONS = ["list", "remove", "reorder", "status"] as const
type Action = (typeof ACTIONS)[number]

function parseArgs(args: string): { action: Action | undefined; rest: string[] } {
  const trimmed = args.trim()
  if (!trimmed) return { action: undefined, rest: [] }
  const tokens = trimmed.split(/\s+/)
  const [action, ...rest] = tokens
  return { action: action as Action | undefined, rest }
}

async function refreshLabels(accounts: Account[], probeResults: Map<string, ProbeResult>) {
  for (const a of accounts) {
    const probe = probeResults.get(a.id)
    if (probe?.username && probe.username !== a.label) {
      a.label = probe.username
      await add({ ...a, label: probe.username })
    }
  }
}

function usageMessage(): string {
  return "Usage: /copilot-accounts <list|remove|reorder|status>\n  remove <username>  — Remove an account\n  reorder <u1> <u2>  — Set priority order"
}

export async function handleAccounts(args: string): Promise<string> {
  const { action, rest } = parseArgs(args)

  if (!action || action === "list") {
    const accounts = await list()
    if (accounts.length === 0) return "No GitHub Copilot accounts configured."
    const probeResults = await probeAll(accounts)
    await refreshLabels(accounts, probeResults)
    const health = status()
    return accounts
      .map((a) => {
        const h = health.get(a.id)
        const probe = probeResults.get(a.id)
        const limited =
          h && h.rate_limited_until > Date.now()
            ? ` [RATE LIMITED until ${new Date(h.rate_limited_until).toISOString()}]`
            : ""
        const probeTag =
          probe?.status === "quota_exhausted"
            ? ` [QUOTA EXHAUSTED${probe.quotaResetDate ? ` resets ${new Date(probe.quotaResetDate).toISOString()}` : ""}]`
            : probe?.status === "rate_limited"
              ? ""
              : probe?.status === "error" && probe.httpStatus
                ? ` [ERROR ${probe.httpStatus}]`
                : probe?.status === "error"
                  ? " [UNREACHABLE]"
                  : probe?.method === "user_api"
                    ? " [QUOTA UNKNOWN]"
                    : ""
        const shortId = a.id.slice(0, 8)
        return `#${a.priority + 1} ${a.label} (${a.domain}) [${shortId}]${limited}${probeTag}`
      })
      .join("\n")
  }

  if (action === "remove") {
    const name = rest[0]
    if (!name) return "Error: username is required. Usage: /copilot-accounts remove <username>"
    const accounts = await list()
    const account = accounts.find((a) => a.label === name) ?? accounts.find((a) => a.id.startsWith(name))
    if (!account) return `Error: no account found matching "${name}".`
    const store = await remove(account.id)
    resetHealth(account.id)
    return `Removed ${account.label}. ${store.accounts.length} account(s) remaining.`
  }

  if (action === "reorder") {
    const names = rest
    if (names.length === 0) {
      return "Error: usernames are required. Usage: /copilot-accounts reorder <username1> <username2> ..."
    }
    const accounts = await list()
    const ids: string[] = []
    for (const name of names) {
      const account = accounts.find((a) => a.label === name) ?? accounts.find((a) => a.id.startsWith(name))
      if (!account) return `Error: no account found matching "${name}".`
      ids.push(account.id)
    }
    await reorder(ids)
    return "Accounts reordered successfully."
  }

  if (action === "status") {
    const accounts = await list()
    if (accounts.length === 0) return "No accounts configured."
    const probeResults = await probeAll(accounts)
    await refreshLabels(accounts, probeResults)
    const health = status()
    return accounts
      .map((a) => {
        const h = health.get(a.id)
        const probe = probeResults.get(a.id)
        const score = h?.score ?? 100
        const limited = h && h.rate_limited_until > Date.now()
        const failures = h?.consecutive_failures ?? 0
        const quotaLine =
          probe?.status === "quota_exhausted"
            ? `  Quota: EXHAUSTED${probe.quotaResetDate ? ` (resets ${new Date(probe.quotaResetDate).toISOString()})` : ""}`
            : probe?.status === "ok" && probe.method === "token_exchange"
              ? "  Quota: available"
              : probe?.status === "ok" && probe.method === "user_api"
                ? "  Quota: unknown (token valid, Copilot endpoint unavailable)"
                : probe?.status === "error" && probe.httpStatus
                  ? `  Probe: ERROR ${probe.httpStatus}`
                  : probe?.status === "error"
                    ? "  Probe: UNREACHABLE"
                    : ""
        return [
          `${a.label} (${a.domain})`,
          `  Priority: #${a.priority + 1}`,
          `  Health: ${score}/100`,
          `  Rate limited: ${
            limited ? `YES until ${new Date(h!.rate_limited_until).toISOString()}` : "no"
          }`,
          `  Consecutive failures: ${failures}`,
          ...(quotaLine ? [quotaLine] : []),
        ].join("\n")
      })
      .join("\n\n")
  }

  return usageMessage()
}
