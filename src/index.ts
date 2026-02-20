import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { copilotBaseURL } from "./types"
import { list } from "./storage"
import { createAuthMethod } from "./auth"
import { createFetch } from "./fetch"
import { handleAccounts } from "./commands"

const VERSION = "0.2.4"

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

    config: async (input) => {
      const config = input as Record<string, any>
      config.command ??= {}
      config.command["copilot-accounts"] = {
        template: "Show the copilot account information above to the user exactly as-is.",
        description: "Manage GitHub Copilot accounts (list, remove, reorder, status)",
      }
    },

    "command.execute.before": async (input) => {
      if (input.command !== "copilot-accounts") return
      const result = await handleAccounts(input.arguments)
      await sdk.tui
        .showToast({
          body: {
            title: "Copilot Accounts",
            message: result,
            variant: "info",
            duration: 10000,
          },
        })
        .catch(() => {})
      throw new Error("__ACCOUNTS_COMMAND_HANDLED__")
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
