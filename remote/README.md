# Codex Local Bridge · Remote

English | [简体中文](README.zh-CN.md)

Version **0.3.1**. This remote component is bundled with the main extension and installed on the Remote-SSH server. It provides a loopback API for official Codex and Claude Code, forwarding requests through the editor's existing remote connection to the local extension and CC Switch. It works alongside [SSH PassBridge](https://github.com/blacker521/ssh-passbridge) without changing the SSH wrapper, `remote.SSH.path`, or SSH credentials.

See the [project README](https://github.com/blacker521/codex-claude-local-bridge) for the complete setup guide and [Releases](https://github.com/blacker521/codex-claude-local-bridge/releases) for the single-file installer. This is a community companion extension; it does not bundle or modify official Codex.

## Quick setup

Command titles in version 0.3.1 are in Chinese. Use the exact titles shown below in the Command Palette.

1. Enable the Codex route and proxy in local CC Switch, then select an available provider.
2. Install the single `codex-local-bridge-0.3.1.vsix` main extension, open the target remote window, and accept the installation prompt or run **`Codex Local Bridge: 安装或更新远程组件`** (install or update the remote component). No separate download of this component is needed.
3. Reload the window and use `Developer: Show Running Extensions` to verify both execution locations.
4. In the remote window, run **`Codex Local Bridge: 检查本机出口`** (check local egress), followed by **`Codex Local Bridge: 配置远程 Codex`** (configure remote Codex).
5. Check the model, path, provider, and bridge address in the dialog, then select “备份并配置” (back up and configure).
6. Run `Developer: Reload Window` and start a **new conversation** in the official Codex sidebar.

The configuration path comes from the remote extension host's `CODEX_HOME/config.toml`, defaulting to remote `~/.codex/config.toml`. It must match the directory used by the Codex app-server. The configuration command updates the top-level model and its own provider section, removes old authentication settings in that section, and preserves other configuration. An existing file is backed up with mode `0600` first. The backup may contain old secrets; store it securely. A new configuration directory uses `0700`, and the file uses `0600`.

Only common single-line TOML that the updater can handle confidently is changed automatically. Complex syntax or an active profile overriding the model leads to the manual configuration path. If the file changes during confirmation, the operation stops. For manual setup, run **`Codex Local Bridge: 选择模型并显示配置`** (choose a model and show configuration), then merge the full snippet:

```toml
# Top-level settings: place before any [table]; use an actual model ID.
model = "your-model-id"
model_provider = "vscode_local_bridge"

[model_providers.vscode_local_bridge]
name = "VS Code Local Bridge"
base_url = "http://127.0.0.1:35721/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
```

The server does not need a Codex login, API key, bridge token, or a copy of local `auth.json`. SSH authentication continues as usual. To upgrade, install the newer main VSIX, run `Codex Local Bridge: 安装或更新远程组件`, reload as prompted, and start a new conversation. For a manual upgrade, remove `experimental_bearer_token`, `env_key`, `auth`, and Authorization headers from the old bridge section.

The main extension and this component retain different extension IDs and run locally and remotely respectively; users obtain only one VSIX. Installation uses the editor's built-in command, does not require the remote server to reach the extension marketplace, and never reloads automatically. If the editor does not support the command, manually install `assets/remote.vsix` from the local main extension's installation directory. Components remain on each server independently; uninstall them as needed.

## Claude Code setup

Enable the separate Claude route in local CC Switch and configure a provider with a valid API / Bearer credential. In the remote window, run `Codex Local Bridge: 检查 Claude 出口` (check Claude egress) and `Codex Local Bridge: 显示远程 Claude 配置` (show remote Claude configuration). Enter a model ID actually supported by that route and merge the generated snippet into the current server's remote user settings JSON. Save, reload, and start a new conversation in the official Claude Code sidebar. Use `/status` to confirm that `ANTHROPIC_BASE_URL` is the server bridge origin, without `/v1`.

The snippet uses `claudeCode.environmentVariables` and `claudeCode.disableLoginPrompt`; the command only displays it and does not write files automatically. Update existing environment-array entries by name and preserve unrelated entries. Merge loopback addresses into `NO_PROXY`. Identically named `env` entries in remote Claude user or project settings may override the startup environment; resolve conflicts with old endpoints, authentication, and cloud-provider routes. This extension does not modify or bypass organization policies. `PROXY_MANAGED` is a public placeholder, not a real key. Remote authentication headers are removed, and local CC Switch manages the actual key.

You can also run `Codex Local Bridge: 打开远程 Claude 终端` (open a remote Claude terminal), which requires `claude` on the remote PATH. It launches with environment variables and a one-time `--settings` argument, without writing persistent settings. Organization or project-enforced configuration may affect the result; verify with `/status`.

The Claude model setting is independent of Codex. Local ChatGPT login is never used for Claude requests. This version does not read or refresh Claude Pro / Max subscription logins. It supports Messages JSON / SSE / tool-call bodies and `?beta=true`. Token-count requests pass through unchanged; availability depends on CC Switch and the upstream. Additional account, file, and search endpoints are not included.

## Commands and settings

All command titles use the `Codex Local Bridge:` prefix. The table preserves their actual Chinese suffixes and explains their purpose in English.

| Command suffix | Purpose |
| --- | --- |
| 启动远程桥接 / 停止远程桥接 | Start or stop the loopback proxy |
| 检查本机出口 | Check the connection and resolved local authentication mode without sending model inference |
| 配置远程 Codex | Update remote user configuration after confirmation and backup |
| 显示现有 Codex 的配置片段 | Select a model automatically and display manual configuration |
| 选择模型并显示配置 | Choose a model explicitly and display configuration |
| 打开远程 Codex 终端 | Run `codex` from the server PATH with one-time process configuration |
| 检查 Claude 出口 | Check the health path without reading Codex login |
| 显示远程 Claude 配置 | Generate the remote user settings snippet for the official sidebar |
| 打开远程 Claude 终端 | Run remote `claude` with one-time process configuration |

| Remote setting | Default |
| --- | --- |
| `codexLocalBridge.remotePort` | `35721`; reconfigure Codex after changing it |
| `codexLocalBridge.autoStart` | `true` |
| `codexLocalBridge.model` | Empty for automatic discovery; a nonempty value explicitly overrides the Codex model |
| `codexLocalBridge.claudeModel` | Empty to prompt when a Claude command runs; a nonempty value explicitly selects the Claude model |

Codex model discovery tries the local CC Switch catalog, the top-level local Codex model, then successful history for the current provider; manual input is supported. History fallback requires local Python 3. Authentication and discovery are separate: successful health checks or model discovery do not prove that a real model request will work.

The local `authentication` setting applies only to Codex. Its default, `auto`, reads an available local ChatGPT file login; otherwise it uses placeholder authentication managed by CC Switch for a third-party provider. An official account requires the local file account and directory to match CC Switch. The bridge does not refresh logins and does not support keychain-only login.

## Troubleshooting and security

- Missing a new command: run the main extension's `Codex Local Bridge: 安装或更新远程组件`, check the current profile and remote environment, then reload as prompted.
- Old bridge-token 401: check both installation locations, versions, and the current listener. Replace the complete provider section and start a new conversation.
- Official provider rejects placeholder authentication: check local `auto` / `local-chatgpt` mode and file login. No additional login on the server is needed.
- Diagnostics pass but the sidebar fails: check the actual remote `CODEX_HOME`, model ID, and provider. Reload, start a new conversation, and inspect the provider error.
- Port already in use: close other bridge windows connected to that server, or change the port and reconfigure.

The remote proxy listens only on `127.0.0.1` and requires no bridge authentication by default. **Other users or processes on the same server that can connect to the port may also make model requests. Use trusted servers only and do not expose the port publicly.** Trust the workspace, editor, and extensions. Keep the window and local CC Switch running; disconnection or reload interrupts requests.

HTTP / SSE is supported; WebSocket is disabled. Use only one bridge window per server and port. If a network proxy is configured, make the app-server connect directly to `127.0.0.1,localhost,::1`. Do not put the CC Switch model endpoint in `HTTP_PROXY`.

See [SECURITY.md](https://github.com/blacker521/codex-claude-local-bridge/blob/main/SECURITY.md) for further boundaries. Released under the MIT license.
