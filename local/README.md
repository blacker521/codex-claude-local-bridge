# Codex Local Bridge

English | [简体中文](README.zh-CN.md)

Version **0.3.1**. This is the single VSIX installation entry point. The main extension runs on your local computer, while its bundled Remote component runs on the server. Model requests from the remote official Codex / Claude Code extension travel through the editor's existing remote connection to your local CC Switch. It works alongside [SSH PassBridge](https://github.com/blacker521/ssh-passbridge). This is a community companion extension; it does not bundle official Codex.

See the [project README](https://github.com/blacker521/codex-claude-local-bridge) for the complete setup guide and [Releases](https://github.com/blacker521/codex-claude-local-bridge/releases) for the single-file installer.

## Install and use

Command titles in version 0.3.1 are in Chinese. The exact titles below can be copied into the Command Palette; the surrounding text explains their purpose.

1. Enable the Codex route and proxy in your local CC Switch, then select a provider.
2. Install `codex-local-bridge-0.3.1.vsix` in the current editor profile. Open the target Remote-SSH window and accept the initial installation prompt, or run **`Codex Local Bridge: 安装或更新远程组件`** (install or update the remote component). No second VSIX download is needed.
3. Run `Developer: Reload Window` when prompted. Use `Developer: Show Running Extensions` to confirm that the main extension runs locally and Remote runs on the server.
4. In the remote window, run **`Codex Local Bridge: 检查本机出口`** (check the local egress), followed by **`Codex Local Bridge: 配置远程 Codex`** (configure remote Codex).
5. Confirm the model and remote configuration path, then select “备份并配置” (back up and configure). Reload the window and start a **new conversation** in the official Codex sidebar.

The initial prompt only offers installation. Clicking it invokes the editor's built-in installer; it does not access the extension marketplace, change SSH settings, or reload the window automatically. If the editor does not support that command, manually install `assets/remote.vsix` from the local main extension's installation directory into the remote environment.

Complex TOML is handled through the manual configuration path. Run `Codex Local Bridge: 选择模型并显示配置` (choose a model and show the configuration) to generate a snippet. The server does not need a Codex login, API key, or bridge token for this bridge. SSH authentication continues as usual.

## Claude Code

The same main extension supports Claude Code; a third bridge extension is not needed. Enable the Claude route in local CC Switch and configure a provider with a valid API / Bearer credential. In the remote window, run `Codex Local Bridge: 检查 Claude 出口` (check Claude egress) and `Codex Local Bridge: 显示远程 Claude 配置` (show remote Claude configuration). Merge the snippet into the remote user settings JSON, reload, and start a new conversation in the official Claude Code sidebar. You can also run `Codex Local Bridge: 打开远程 Claude 终端` (open a remote Claude terminal); `claude` must already be on the remote PATH.

Claude uses the separate `codexLocalBridge.claudeModel` setting and does not reuse the Codex model. Its requests skip local ChatGPT login parsing. This version does not read or refresh Claude Pro / Max subscription logins. Only local CC Switch injects the real key; the remote client uses a public placeholder. See the project README for the full procedure.

## Local settings

```json
{
  "codexLocalBridge.upstreamOrigin": "http://127.0.0.1:2900",
  "codexLocalBridge.authentication": "auto"
}
```

`2900` is this extension's default port. Use the actual port configured in CC Switch. The upstream must be an HTTP(S) origin on `localhost`, `127.0.0.1`, or `[::1]`, without a path, username, query, or fragment. Redirects are not followed. Changing the address cancels existing requests.

| Setting | Default and purpose |
| --- | --- |
| `codexLocalBridge.upstreamOrigin` | `http://127.0.0.1:2900`, the local CC Switch address |
| `codexLocalBridge.authentication` | `auto`, the local authentication mode |
| `codexLocalBridge.codexHome` | Empty; uses local `CODEX_HOME` or `~/.codex`. A custom value must be an absolute path |
| `codexLocalBridge.ccSwitchHome` | Empty; uses `~/.cc-switch`, only for model-history fallback |

## Authentication and models

- `auto`: loads a local ChatGPT file login when available; otherwise uses `PROXY_MANAGED`, letting CC Switch inject the third-party key.
- `proxy-managed`: does not read the login file; suitable for third-party API routes only.
- `local-chatgpt`: requires a usable local ChatGPT file login.

An official Codex account route needs `tokens.access_token` and `tokens.account_id` from local `auth.json`. They are used only for requests from the local extension to CC Switch and are never returned to the server. The file directory and account must match the official account selected in CC Switch. The bridge does not write or refresh the login, and keychain-only logins are not currently supported. Authentication headers received from the server are removed.

Models are discovered from CC Switch `/v1/models`, the top-level `model` in local Codex configuration, then the most recent successful request for the current Codex provider in CC Switch. Manual input is the final fallback. History fallback requires Python 3 and proves only that a model worked previously, not that current access remains valid. Discovery returns model metadata only and uses placeholder authentication for catalog requests; successful discovery does not prove successful official-route authentication.

## Diagnostics and limits

`Codex Local Bridge: 查看本机状态` (show local status) displays only the address, session count, and protocol version. `Codex Local Bridge: 检查本机出口` checks the connection and resolved authentication mode without sending a model inference request.

Local does not listen on a TCP port. Remote listens only on the server's `127.0.0.1`, with no bridge authentication by default. **Other users or processes on the same server that can connect to this port may also call the model. Use a trusted server and do not expose the port.** The workspace, editor, and extensions must be trusted. Prompts and responses pass through your local computer and the selected provider.

Supported HTTP / SSE routes are GET `/health` and `/v1/models`, and POST `/v1/responses`, `/v1/responses/compact`, `/v1/messages`, and `/v1/messages/count_tokens`. Both Messages paths accept the exact `?beta=true` query. Token-count support depends on CC Switch and the provider; an upstream 404 is returned unchanged. Each broker allows up to 8 sessions, a 32 MiB request body, and 64 KiB cross-host chunks. An active stream has no fixed total duration limit. Keep local CC Switch and the remote editor window running.

To upgrade, install the newer main VSIX, run `Codex Local Bridge: 安装或更新远程组件`, and reload. An equal or newer remote version is not overwritten with an older version. The main extension and remote component remain two entries in the extension list because code must run on both machines. Uninstall each side as needed. Start a new conversation after reconfiguration. If an old bridge-token error appears, check for an old running version or an installation in a different editor profile. See [SECURITY.md](https://github.com/blacker521/codex-claude-local-bridge/blob/main/SECURITY.md). Released under the MIT license.
