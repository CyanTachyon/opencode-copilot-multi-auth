# opencode-copilot-multi-auth
Multiple account support and automatic failover for GitHub Copilot in OpenCode.

## Features
- Multi-account support for GitHub Copilot.
- Automatic failover when hitting rate limits (HTTP 429).
- Support for github.com and GitHub Enterprise.
- Priority-based account recovery.
- Proactive health probing — detects rate-limited accounts before use.
- Auto-resolves GitHub username as account label during login.

## Install

Edit `~/.config/opencode/opencode.json` and add the plugin to the `plugin` array:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-copilot-multi-auth"
  ]
}
```

Then restart OpenCode. The plugin will be installed automatically.

## Usage

After installing the plugin, start OpenCode and use the `/connect` command to add your GitHub Copilot accounts. You can run `/connect` multiple times — each successful login adds a new account to your pool.

The plugin automatically resolves your GitHub username and uses it as the account label, so you can easily identify accounts.

OpenCode uses accounts in priority order. The first account added has the highest priority. When an account receives a 429 rate limit error, the plugin automatically switches to the next available account.

## Account Management Commands

The plugin registers the `/copilot-accounts` command for direct account management.

- `/copilot-accounts` or `/copilot-accounts list` — Shows all configured accounts with username, priority, and rate limit status.
- `/copilot-accounts remove <username>` — Removes a specific account from the pool.
- `/copilot-accounts reorder <username1> <username2> ...` — Changes the priority order of your accounts.
- `/copilot-accounts status` — Displays detailed health and rate limit status for each account.

## Environment Variables

- `COPILOT_MULTI_AUTH_DATA_DIR`: Override the storage location for account tokens. Defaults to `~/.local/share/opencode/`.

## How It Works

This plugin overrides the built-in GitHub Copilot authentication provider. It maintains a pool of tokens and tracks the health of each account in memory. Before displaying account status, the plugin proactively probes each account to detect rate limits. If a request fails with a 429 status code, the plugin automatically retries using the next available account. Health status resets when you restart OpenCode. The primary account stays synced with the standard OpenCode `auth.json` file for compatibility.

## License
MIT
