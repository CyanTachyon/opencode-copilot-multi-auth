import {
  CLIENT_ID,
  OAUTH_POLLING_SAFETY_MARGIN_MS,
  normalizeDomain,
  getUrls,
  type Account,
} from "./types"
import { add } from "./storage"
import type { AuthOuathResult } from "@opencode-ai/plugin"

export function createAuthMethod(version: string) {
  const agent = `opencode/${version}`

  return {
    type: "oauth" as const,
    label: "Add GitHub Copilot Account",
    prompts: [
      {
        type: "select" as const,
        key: "deploymentType",
        message: "Select GitHub deployment type",
        options: [
          { label: "GitHub.com", value: "github.com", hint: "Public" },
          { label: "GitHub Enterprise", value: "enterprise", hint: "Data residency or self-hosted" },
        ],
      },
      {
        type: "text" as const,
        key: "enterpriseUrl",
        message: "Enter your GitHub Enterprise URL or domain",
        placeholder: "company.ghe.com or https://company.ghe.com",
        condition: (inputs: Record<string, string>) => inputs.deploymentType === "enterprise",
        validate: (value: string) => {
          if (!value) return "URL or domain is required"
          try {
            const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`)
            if (!url.hostname) return "Please enter a valid URL or domain"
            return undefined
          } catch {
            return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)"
          }
        },
      },
      {
        type: "text" as const,
        key: "accountLabel",
        message: "Label for this account (e.g., personal, work)",
        placeholder: "personal",
      },
    ],
    async authorize(inputs: Record<string, string> = {}): Promise<AuthOuathResult> {
      const deploymentType = inputs.deploymentType || "github.com"
      let domain = "github.com"
      let actualProvider = "github-copilot"

      if (deploymentType === "enterprise") {
        domain = normalizeDomain(inputs.enterpriseUrl!)
        actualProvider = "github-copilot-enterprise"
      }

      const urls = getUrls(domain)
      const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": agent,
        },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          scope: "read:user",
        }),
      })

      if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

      const deviceData = (await deviceResponse.json()) as {
        verification_uri: string
        user_code: string
        device_code: string
        interval: number
      }

      const label = inputs.accountLabel || `account-${Date.now()}`

      return {
        url: deviceData.verification_uri,
        instructions: `Enter code: ${deviceData.user_code}`,
        method: "auto" as const,
        async callback() {
          while (true) {
            const response = await fetch(urls.ACCESS_TOKEN_URL, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "User-Agent": agent,
              },
              body: JSON.stringify({
                client_id: CLIENT_ID,
                device_code: deviceData.device_code,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              }),
            })

            if (!response.ok) return { type: "failed" as const }

            const data = (await response.json()) as {
              access_token?: string
              error?: string
              interval?: number
            }

            if (data.access_token) {
              const account: Account = {
                id: crypto.randomUUID(),
                label,
                domain,
                token: data.access_token,
                added_at: Date.now(),
                priority: Date.now(),
              }
              const store = await add(account)
              account.priority = store.accounts.findIndex((a) => a.id === account.id)

              const result: {
                type: "success"
                refresh: string
                access: string
                expires: number
                provider?: string
                enterpriseUrl?: string
              } = {
                type: "success",
                refresh: data.access_token,
                access: data.access_token,
                expires: 0,
              }

              if (actualProvider === "github-copilot-enterprise") {
                result.provider = "github-copilot-enterprise"
                result.enterpriseUrl = domain
              }

              return result
            }

            if (data.error === "authorization_pending") {
              await Bun.sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
              continue
            }

            if (data.error === "slow_down") {
              let interval = (deviceData.interval + 5) * 1000
              const serverInterval = data.interval
              if (serverInterval && typeof serverInterval === "number" && serverInterval > 0) {
                interval = serverInterval * 1000
              }
              await Bun.sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS)
              continue
            }

            if (data.error) return { type: "failed" as const }

            await Bun.sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
            continue
          }
        },
      }
    },
  }
}
