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

## Account Management Tool
The `copilot_accounts` tool provides direct control over your account pool. It supports several actions:
- `list`: Shows all configured accounts and their current priority.
- `remove`: Deletes a specific account from the pool.
- `reorder`: Changes the priority of your accounts.
- `status`: Displays the health and rate limit status of each account.

Example usage: "Use the copilot_accounts tool to list all accounts"

## Environment Variables
The plugin uses a specific directory for storing account tokens and configuration.
- `COPILOT_MULTI_AUTH_DATA_DIR`: Set this to change the storage location. It defaults to `~/.local/share/opencode/`.

## How It Works
This plugin overrides the built-in GitHub Copilot authentication provider. It maintains a collection of tokens and tracks the health of each account in memory. If a request fails with a 429 status code, the plugin automatically retries the operation using the next account in your priority list. Health status resets when you restart OpenCode. The primary account information stays synced with the standard OpenCode `auth.json` file for compatibility.

## License
MIT
