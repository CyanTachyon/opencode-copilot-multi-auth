import { list, remove, reorder } from "./storage"
import { status, resetHealth } from "./rotation"
import { probeAll } from "./probe"

const ACTIONS = ["list", "remove", "reorder", "status"] as const
type Action = (typeof ACTIONS)[number]

function parseArgs(args: string): { action: Action | undefined; rest: string[] } {
  const trimmed = args.trim()
  if (!trimmed) return { action: undefined, rest: [] }
  const tokens = trimmed.split(/\s+/)
  const [action, ...rest] = tokens
  return { action: action as Action | undefined, rest }
}

function usageMessage(): string {
  return "Usage: /copilot-accounts <list|remove|reorder|status>"
}

export async function handleAccounts(args: string): Promise<string> {
  const { action, rest } = parseArgs(args)

  if (!action || action === "list") {
    const accounts = await list()
    if (accounts.length === 0) return "No GitHub Copilot accounts configured."
    await probeAll(accounts)
    const health = status()
    return accounts
      .map((a) => {
        const h = health.get(a.id)
        const limited =
          h && h.rate_limited_until > Date.now()
            ? ` [RATE LIMITED until ${new Date(h.rate_limited_until).toISOString()}]`
            : ""
        const shortId = a.id.slice(0, 8)
        return `#${a.priority + 1} ${a.label} (${a.domain}) [${shortId}]${limited}`
      })
      .join("\n")
  }

  if (action === "remove") {
    const id = rest[0]
    if (!id) return "Error: account ID is required. Usage: /copilot-accounts remove <id>"
    const store = await remove(id)
    resetHealth(id)
    return `Removed. ${store.accounts.length} account(s) remaining.`
  }

  if (action === "reorder") {
    const ids = rest
    if (ids.length === 0) {
      return "Error: account IDs are required. Usage: /copilot-accounts reorder <id1> <id2> ..."
    }
    await reorder(ids)
    return "Accounts reordered successfully."
  }

  if (action === "status") {
    const accounts = await list()
    if (accounts.length === 0) return "No accounts configured."
    await probeAll(accounts)
    const health = status()
    return accounts
      .map((a) => {
        const h = health.get(a.id)
        const score = h?.score ?? 100
        const limited = h && h.rate_limited_until > Date.now()
        const failures = h?.consecutive_failures ?? 0
        return [
          `${a.label} (${a.domain})`,
          `  Priority: #${a.priority + 1}`,
          `  Health: ${score}/100`,
          `  Rate limited: ${
            limited ? `YES until ${new Date(h!.rate_limited_until).toISOString()}` : "no"
          }`,
          `  Consecutive failures: ${failures}`,
        ].join("\n")
      })
      .join("\n\n")
  }

  return usageMessage()
}
