import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { copilotBaseURL } from "./types"
import { list, remove, reorder } from "./storage"
import { createAuthMethod } from "./auth"
import { createFetch } from "./fetch"
import { status, resetHealth } from "./rotation"

const VERSION = "0.1.0"

export default async function(input: PluginInput): Promise<Hooks> {
  const sdk = input.client
  const copilotFetch = createFetch(VERSION)

  return {
    auth: {
      provider: "github-copilot",
      async loader(getAuth, provider) {
        const info = await getAuth()
        if (!info || info.type !== "oauth") return {}

        const accounts = await list()
        const primary = accounts[0]
        const domain = primary?.domain ?? "github.com"
        const baseURL = copilotBaseURL(domain)

        if (provider?.models) {
          for (const model of Object.values(provider.models)) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
            model.api.npm = "@ai-sdk/github-copilot"
          }
        }

        return {
          baseURL,
          apiKey: "",
          fetch: copilotFetch,
        }
      },
      methods: [createAuthMethod(VERSION)],
    },

    tool: {
      copilot_accounts: tool({
        description: "Manage GitHub Copilot accounts. Actions: list, remove, reorder, status.",
        args: {
          action: tool.schema.enum(["list", "remove", "reorder", "status"]),
          id: tool.schema.string().optional().describe("Account ID for remove action"),
          ids: tool.schema.array(tool.schema.string()).optional().describe("Ordered account IDs for reorder action"),
        },
        async execute(args) {
          if (args.action === "list") {
            const accounts = await list()
            if (accounts.length === 0) return "No GitHub Copilot accounts configured."
            const health = status()
            return accounts.map((a) => {
              const h = health.get(a.id)
              const limited = h && h.rate_limited_until > Date.now()
                ? ` [RATE LIMITED until ${new Date(h.rate_limited_until).toISOString()}]`
                : ""
              return `#${a.priority + 1} ${a.label} (${a.domain}) id:${a.id}${limited}`
            }).join("\n")
          }

          if (args.action === "remove") {
            if (!args.id) return "Error: id is required for remove action"
            const store = await remove(args.id)
            resetHealth(args.id)
            return `Removed. ${store.accounts.length} account(s) remaining.`
          }

          if (args.action === "reorder") {
            if (!args.ids || args.ids.length === 0) return "Error: ids array is required for reorder action"
            await reorder(args.ids)
            return "Accounts reordered successfully."
          }

          if (args.action === "status") {
            const accounts = await list()
            const health = status()
            if (accounts.length === 0) return "No accounts configured."
            return accounts.map((a) => {
              const h = health.get(a.id)
              const score = h?.score ?? 100
              const limited = h && h.rate_limited_until > Date.now()
              const failures = h?.consecutive_failures ?? 0
              return [
                `${a.label} (${a.domain})`,
                `  Priority: #${a.priority + 1}`,
                `  Health: ${score}/100`,
                `  Rate limited: ${limited ? `YES until ${new Date(h!.rate_limited_until).toISOString()}` : "no"}`,
                `  Consecutive failures: ${failures}`,
              ].join("\n")
            }).join("\n\n")
          }

          return `Unknown action: ${args.action}`
        },
      }),
    },

    "chat.headers": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return

      if (incoming.model.api.npm === "@ai-sdk/anthropic") {
        output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
      }

      const session = await sdk.session
        .get({
          path: { id: incoming.sessionID },
          query: { directory: input.directory },
          throwOnError: true,
        })
        .catch(() => undefined)
      if (!session || !session.data.parentID) return
      output.headers["x-initiator"] = "agent"
    },
  }
}
