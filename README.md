# opencode-copilot-multi-auth
Multiple account support and automatic failover for GitHub Copilot in OpenCode.

## Features
- Multi-account support for GitHub Copilot.
- Automatic failover when hitting rate limits (HTTP 429).
- Support for github.com and GitHub Enterprise.
- Priority-based account recovery.
- Built-in management tool for account lifecycle.

## Install
```bash
npm install opencode-copilot-multi-auth
```

## Configuration
Add the plugin to your `opencode.json` configuration file:
```json
{
  "plugins": {
    "opencode-copilot-multi-auth": true
  }
}
```

## Usage
After you install the plugin, start OpenCode and use the `/login` command to add your accounts. You can run `/login` multiple times. Each successful login adds a new account to your pool. OpenCode uses accounts in the order they were added. The first account has the highest priority. When an account receives a 429 rate limit error, the plugin automatically switches to the next available account.

## Account Management Commands
The plugin auto-registers the `/copilot-accounts` command for direct account management.

- `/copilot-accounts` or `/copilot-accounts list` — Shows all configured accounts, their priority, and rate limit status.
- `/copilot-accounts remove <id>` — Removes a specific account from the pool.
- `/copilot-accounts reorder <id1> <id2> ...` — Changes the priority order of your accounts.
- `/copilot-accounts status` — Displays detailed health and rate limit status for each account.

## Environment Variables
The plugin uses a specific directory for storing account tokens and configuration.
- `COPILOT_MULTI_AUTH_DATA_DIR`: Set this to change the storage location. It defaults to `~/.local/share/opencode/`.

## How It Works
This plugin overrides the built-in GitHub Copilot authentication provider. It maintains a collection of tokens and tracks the health of each account in memory. If a request fails with a 429 status code, the plugin automatically retries the operation using the next account in your priority list. Health status resets when you restart OpenCode. The primary account information stays synced with the standard OpenCode `auth.json` file for compatibility.

## License
MIT
