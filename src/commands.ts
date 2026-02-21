import { list, remove, reorder } from "./storage"
import { status, resetHealth, hasBeenUsed } from "./rotation"
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

function usageMessage(): string {
  return `Usage: /copilot-accounts <list|remove|reorder|status>
  remove <username>  — Remove an account
  reorder <u1> <u2>  — Set priority order`
}

export async function handleAccounts(args: string): Promise<string> {
  const { action, rest } = parseArgs(args)

  if (!action || action === "list") {
    const accounts = await list()
    if (accounts.length === 0) return "No GitHub Copilot accounts configured."
    const health = status()
    return accounts
      .map((a) => {
        const h = health.get(a.id)
        const limited = h && h.rate_limited_until > Date.now()
        const tag = limited
          ? ` [RATE LIMITED until ${new Date(h!.rate_limited_until).toISOString()}]`
          : !hasBeenUsed(a.id)
            ? " [UNKNOWN]"
            : ""
        const shortId = a.id.slice(0, 8)
        return `#${a.priority + 1} ${a.label} (${a.domain}) [${shortId}]${tag}`
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
    const health = status()
    return accounts
      .map((a) => {
        const h = health.get(a.id)
        const used = hasBeenUsed(a.id)
        const limited = h && h.rate_limited_until > Date.now()
        const rateLimitLine = !used
          ? "  Rate limited: unknown"
          : limited
            ? `  Rate limited: yes (until ${new Date(h!.rate_limited_until).toISOString()})`
            : "  Rate limited: no"
        return [
          `--- ${a.label} (${a.id}) ---`,
          `  Priority: #${a.priority + 1}`,
          rateLimitLine,
        ].join("\n")
      })
      .join("\n\n")
  }

  return usageMessage()
}
