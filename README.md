# Codex & Claude Local Bridge

English | [简体中文](README.zh-CN.md)

Route **Codex and Claude Code running on a remote server** through CC Switch on your local computer. Install one VSIX and keep using the official Codex or Claude Code sidebar in VS Code / Cursor. File edits and commands still run on the server.

**Current version: 0.3.1. The server does not need a real provider key or a provider login for the bridge. Provider authentication stays local. The Codex loopback API requires no authentication; Claude uses a public placeholder to enter gateway mode.** Keep your existing SSH login method, including [SSH PassBridge](https://github.com/blacker521/ssh-passbridge). This is a community companion extension. It does not include or modify the official Codex / Claude Code extensions and is not affiliated with OpenAI, Anthropic, VS Code, Cursor, or CC Switch.

```text
Server: official Codex / Claude Code extension or CLI
                         ↓
              http://127.0.0.1:35721
               Codex: /v1/responses
               Claude: /v1/messages
                         ↓ Remote component
           Existing VS Code / Cursor remote connection
                         ↓ Local component
Local computer:       CC Switch → Model provider
```

The bridge reuses your editor's remote connection. The server does not need to reach your local IP address, and no additional SSH `-R` forwarding is required. The local component only accepts a loopback CC Switch endpoint; the remote API listens only on the server's `127.0.0.1`.

## Quick start

### 1. Prepare your environment

- Open a server directory through Remote-SSH in desktop VS Code / Cursor, and trust the workspace.
- Install the official Codex or Claude Code extension as needed. Check that it runs on the server in the remote window.
- Configure a working provider in local CC Switch and enable the corresponding Codex / Claude route and proxy service. Both routes can be enabled at once; each uses its own provider selection in CC Switch.
- The bridge requires VS Code `1.85+`. Meet the official extensions' requirements separately; the Claude Code extension requires VS Code `1.94+`. Compatible editors such as Cursor must also support commands across extension hosts.

The bridge defaults to `http://127.0.0.1:2900`. **This is the bridge's default, not a guarantee of CC Switch's actual port. Check your CC Switch settings.** Change it in your local user settings:

```json
{
  "codexLocalBridge.upstreamOrigin": "http://127.0.0.1:2900",
  "codexLocalBridge.authentication": "auto"
}
```

Check the service on your local computer:

```bash
curl --noproxy '*' --max-time 5 http://127.0.0.1:2900/health
```

### 2. Install one VSIX

Download **`codex-local-bridge-0.3.1.vsix`** from [Releases](https://github.com/blacker521/codex-claude-local-bridge/releases), then run `Extensions: Install from VSIX...` from the Command Palette. This installs the local main extension, which includes the matching remote component. You do not need a second download or a Marketplace download for the remote component.

The extension's command titles are currently Chinese. The instructions below retain their exact titles so you can find and run them.

1. Install the main extension in the editor profile you use, then open the target server's Remote-SSH window.
2. If prompted about a missing remote component, select `安装远程组件` (Install remote component). You can also run **`Codex Local Bridge: 安装或更新远程组件`** (Install or update remote component).
3. The editor installs the bundled component in the current remote environment. Run `Developer: Reload Window` when prompted, then check the connection.
4. Use `Developer: Show Running Extensions` to confirm that the main extension runs locally and the Remote component runs on the server.

**One VSIX provides the installation entry point; two extension components still run underneath.** VS Code chooses one execution location for each extension. This bridge needs both the local outgoing connection and the server's loopback proxy, so combining two manifests into one would not provide both hosts. Both components retain their original extension IDs for upgrades and remain visible in the extension list.

Installing the remote component requires clicking the prompt or running the command. It does not install silently or reload the window automatically. The installer checks the remote version and does not overwrite an equal or newer version with an older one. If installation finishes but the component is not yet active, it asks you to reload; you can check again afterward. Each remote host needs its own component. With named profiles, work in the profile used by the current window.

If your editor does not support the built-in VSIX installation command, locate `assets/remote.vsix` in the main extension's local installation directory and install it manually through `Extensions: Install from VSIX...` in the remote window. No SSH configuration changes or authentication-file copying are needed.

The optional **`codex-local-bridge-0.3.1.zip`** contains the main VSIX, guides, license, and checksums. The release page's `SHA256SUMS-0.3.1.txt` verifies both the main VSIX and the ZIP. The file with the same name inside the extracted bundle verifies only the main VSIX. Run the appropriate command in the directory containing those files:

```bash
# Linux
sha256sum -c SHA256SUMS-0.3.1.txt
# macOS
shasum -a 256 -c SHA256SUMS-0.3.1.txt
```

### 3. Configure remote Codex

In the target remote window:

1. Run **`Codex Local Bridge: 检查本机出口`** (Check local connection).
2. Run **`Codex Local Bridge: 配置远程 Codex`** (Configure remote Codex). The extension discovers models automatically and asks you to select or enter an actual model ID when necessary.
3. Check the remote configuration path, model, provider, and bridge URL in the dialog, then select `备份并配置` (Back up and configure).
4. Run `Developer: Reload Window`, then start a **new conversation** in the official Codex sidebar to test it.

The configuration command uses `CODEX_HOME/config.toml` from the remote extension host, defaulting to remote `~/.codex/config.toml`. Make sure this matches the directory used by the Codex app-server. It updates the top-level `model`, `model_provider`, and its own provider section, removes old authentication fields from that section, and preserves other settings. Before writing, it backs up an existing file with mode `0600`. **A backup may contain sensitive values from the original configuration. Store it privately; do not upload it to the repository or an issue.** Newly created directories use `0700`, and configuration files use `0600`.

The updater handles only common single-line TOML syntax it can identify safely. Multiline strings, arrays of tables, or an active profile overriding the model cause it to stop and offer manual configuration. It does not guess how to rewrite them. If the file changes while you are confirming, it asks you to check again.

For manual setup, run **`Codex Local Bridge: 选择模型并显示配置`** (Select model and show configuration), then merge the complete snippet into your remote user configuration. Replace the example model with an actual ID:

```toml
# Place before any [table]; replace existing keys to avoid duplicate definitions.
model = "your-model-id"
model_provider = "vscode_local_bridge"

[model_providers.vscode_local_bridge]
name = "VS Code Local Bridge"
base_url = "http://127.0.0.1:35721/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
```

Existing conversations may retain their original provider; reloading does not switch them automatically. You do not need to copy local `auth.json` to the server or run `codex login` there.

## Connect Claude Code

Claude and Codex share the bridge port. In CC Switch, **enable the Claude route separately** and select a provider configured with a valid API / Bearer key. Claude does not automatically reuse the Codex model or read the ChatGPT login. This version does not read, refresh, or forward a local Claude Pro / Max subscription login.

### Official Claude Code sidebar

1. Install or update the remote component, and install the official Claude Code extension in the remote environment.
2. Run **`Codex Local Bridge: 检查 Claude 出口`** (Check Claude connection), then **`Codex Local Bridge: 显示远程 Claude 配置`** (Show remote Claude configuration).
3. Enter a model ID actually supported by the **Claude route** in CC Switch. Set remote `codexLocalBridge.claudeModel` to avoid repeated prompts; this setting is separate from the Codex model.
4. Merge the generated JSONC snippet into **the current server's remote user settings JSON**. Do not replace the whole file. If `claudeCode.environmentVariables` already exists, update entries by `name` and preserve unrelated entries. Preserve existing `NO_PROXY` entries and add the loopback addresses.
5. Run `Developer: Reload Window`, start a new Claude Code sidebar conversation, and use `/status` to confirm that the Anthropic base URL is `http://127.0.0.1:35721`.

Minimal example; replace the model with an actual ID. The full generated snippet also clears other cloud-provider selectors and old authentication variables to avoid conflicts:

```json
{
  "claudeCode.disableLoginPrompt": true,
  "claudeCode.environmentVariables": [
    { "name": "ANTHROPIC_BASE_URL", "value": "http://127.0.0.1:35721" },
    { "name": "ANTHROPIC_AUTH_TOKEN", "value": "PROXY_MANAGED" },
    { "name": "ANTHROPIC_API_KEY", "value": "" },
    { "name": "CLAUDE_CODE_OAUTH_TOKEN", "value": "" },
    { "name": "ANTHROPIC_MODEL", "value": "your-claude-model-id" }
  ]
}
```

`ANTHROPIC_BASE_URL` is an **origin, without `/v1`**. `PROXY_MANAGED` is a public placeholder, not a real key. The remote proxy removes it; local CC Switch injects the real provider credentials. You do not need to run `/login` on the server. The official extension's pre-launch login check reads `claudeCode.environmentVariables`; configuring only remote `~/.claude/settings.json` may still show a login prompt. See the [official Claude gateway setup guide](https://code.claude.com/docs/en/llm-gateway-connect#vs-code-extension).

This command only displays a snippet; it does not modify Claude, editor, or SSH settings automatically. Matching `env` entries in remote `~/.claude/settings.json` or project settings may override the extension's launch environment. Resolve old endpoint, authentication, and cloud-provider conflicts. Organization policy has higher priority; the bridge does not change or bypass it. The generated snippet initially maps the Haiku / Sonnet / Opus tiers to the selected model ID; adjust each tier to suit your provider. It also recommends disabling nonessential Claude network traffic. External MCP servers, web access, and other tools' network requests do not go through the model bridge.

### Claude Code CLI

Run **`Codex Local Bridge: 打开远程 Claude 终端`** (Open remote Claude terminal). The server must have `claude` on its PATH. The command sets the gateway URL, placeholder authentication, and model through the terminal environment and a per-invocation `--settings` argument. It preserves the existing `NO_PROXY` list and does not change persistent configuration. Enforced project or organization settings may affect routing; check `/status`. The bridge does not bypass organization policy.

The bridge supports Anthropic Messages JSON, tool-call bodies, SSE, and the exact `?beta=true` query. `/v1/messages/count_tokens` is forwarded unchanged to CC Switch. **Support depends on the CC Switch and provider versions**; an upstream 404 is returned unchanged, without inventing a token count. Additional login, account, search, and file endpoints are not implemented.

## Authentication and trust boundaries

Provider authentication happens on the local component's requests to CC Switch, not in cross-host command payloads or remote configuration. The following `authentication` setting affects only Codex. Claude always uses CC Switch-managed authentication and skips reading the local ChatGPT login.

| Local setting `codexLocalBridge.authentication` | Behavior |
| --- | --- |
| `auto` (default) | Loads a local ChatGPT file login when available; otherwise uses the `PROXY_MANAGED` placeholder so CC Switch can inject the third-party key |
| `proxy-managed` | Does not read the login file; suitable for third-party API routes |
| `local-chatgpt` | Requires a usable local ChatGPT file login |

CC Switch's official account route requires a real ChatGPT login. The local extension reads only the access token and account ID from local `auth.json`, using them only for requests to local CC Switch. **The account in that file must match the official account selected in CC Switch.** The local directory is resolved from `codexLocalBridge.codexHome`, then local `CODEX_HOME`, then `~/.codex`. Use an absolute path for a custom directory. The bridge does not refresh or write the login file. A login stored only in the system keychain is currently unsupported.

The remote proxy requires no authentication by default. **Other users or processes on the same server that can reach the loopback port may also send model requests.** Use a trusted remote host, and do not forward or expose this port publicly. Local CC Switch, the remote workspace, the editor, and its extensions are part of the trust boundary. Request contents pass through your local computer and the selected provider. See [Security](SECURITY.md).

## Automatic model ID discovery

A nonempty remote `codexLocalBridge.model` setting takes precedence. Otherwise, the local component checks the following sources in order, falling back only when the preceding source has no usable results:

1. CC Switch `/v1/models`, supporting OpenAI `data[].id` and Codex `models[].slug`.
2. The top-level `model` in the local Codex configuration.
3. The model ID from the latest successful request for CC Switch's current Codex provider. This fallback requires local Python 3. The default database is `~/.cc-switch/cc-switch.db`; override its directory with `codexLocalBridge.ccSwitchHome`.
4. Manual input.

Display names are never guessed into model IDs. A history candidate does not guarantee current access, quota, or routing. Discovery returns only model metadata; its catalog request uses placeholder authentication. Successful catalog or history discovery does not prove provider authentication works.

Ordinary configuration commands use the current model if it is among the candidates, or the only candidate if there is one. Multiple candidates open a picker. **`Codex Local Bridge: 选择模型并显示配置`** (Select model and show configuration) always allows an explicit selection.

## Commands

Run these commands in the target remote window. The local component provides the local-status command. Titles below are the actual Chinese Command Palette entries.

| Command title | Purpose |
| --- | --- |
| `Codex Local Bridge: 安装或更新远程组件` | Install or update the current remote environment from the bundled component |
| `Codex Local Bridge: 查看本机状态` | Show the local CC Switch URL, session count, and protocol version |
| `Codex Local Bridge: 启动远程桥接` / `Codex Local Bridge: 停止远程桥接` | Start or stop the server's loopback proxy |
| `Codex Local Bridge: 检查本机出口` | Check the connection and local authentication mode without sending a model inference request |
| `Codex Local Bridge: 配置远程 Codex` | Preview, confirm, back up, and update the remote user configuration |
| `Codex Local Bridge: 显示现有 Codex 的配置片段` | Select a model automatically and display a manual configuration snippet |
| `Codex Local Bridge: 选择模型并显示配置` | Choose a model explicitly and display its configuration snippet |
| `Codex Local Bridge: 打开远程 Codex 终端` | Launch remote `codex` with per-invocation configuration |
| `Codex Local Bridge: 检查 Claude 出口` | Check the health path without reading the Codex login or sending model inference |
| `Codex Local Bridge: 显示远程 Claude 配置` | Generate remote user settings for the official sidebar |
| `Codex Local Bridge: 打开远程 Claude 终端` | Launch remote `claude` with per-invocation configuration |

The Codex CLI command requires `codex` on the server PATH; the official sidebar does not. Change the remote port with `codexLocalBridge.remotePort`, default `35721`, then update the client configuration. `codexLocalBridge.autoStart` defaults to `true`.

## Upgrades and troubleshooting

To upgrade from 0.2.x, install the new main VSIX, which updates the original Local extension. Open the remote window and run **`Codex Local Bridge: 安装或更新远程组件`** (Install or update remote component). Reload, then run **`Codex Local Bridge: 配置远程 Codex`** (Configure remote Codex). Uninstalling the main extension may leave remote components on individual servers; remove them separately as needed. When manually upgrading from an older token-based version, replace the complete bridge provider section. Remove its old `experimental_bearer_token`, `env_key`, `auth`, and Authorization header settings, and keep `requires_openai_auth = false`. Then start a new conversation.

| Symptom | What to check |
| --- | --- |
| Configuration or model-selection command is missing | Run `Codex Local Bridge: 安装或更新远程组件`, check the current profile and remote installation location, then reload |
| An invalid bridge-token error appears | An old process may still be running. Check both component versions, the listening port, and old configuration; reinstall and reload |
| Official provider says the request still uses third-party configuration | Check local `auto` or `local-chatgpt` authentication and that the file login's directory and account match CC Switch |
| Configuration command asks for manual setup | Complex TOML or profile overrides need a manual merge; use the generated snippet and preserve other settings |
| Port is already in use | Close other bridge windows for that server, or change the port and reconfigure |
| Health check succeeds but a conversation fails | Check the model ID, actual `CODEX_HOME`, provider, and upstream error; test a new conversation |
| Terminal works but the sidebar fails | Confirm that the app-server reads the updated remote configuration. If using a network proxy, ensure `NO_PROXY` contains `127.0.0.1,localhost,::1` |

The CC Switch URL is a model provider's `base_url`. Do not use it as `HTTP_PROXY` or VS Code's `http.proxy`. Remove prompts, responses, accounts, keys, and personal paths before sharing diagnostics.

## Supported scope

Keep local CC Switch and the remote editor window running. Disconnection or reload interrupts requests. Use one bridge window per server and listening port. The bridge does not modify `remote.SSH.path`, SSH wrappers, or SSH credentials, and can run alongside SSH PassBridge.

Supported HTTP / SSE paths are `/health`, `/v1/models`, `/v1/responses`, `/v1/responses/compact`, `/v1/messages`, and `/v1/messages/count_tokens`. Both Messages paths also accept the exact `?beta=true` query. The server has an additional `/bridge/auth-check` diagnostic endpoint. Each window supports up to 8 sessions, a 32 MiB request body, and 64 KiB cross-host chunks. Idle operations and individual RPC waits have timeouts; a continuously streaming SSE response has no fixed total-duration limit. WebSocket, additional media paths, standalone search endpoints, and resuming interrupted requests are not implemented.

## Development and packaging

Use Node.js **22+**, npm, and Python 3. The extensions have no third-party Node runtime dependencies. The development packaging tools are locked in `package-lock.json`; no global `vsce` installation is needed. Publication checks also require [Gitleaks](https://github.com/gitleaks/gitleaks).

```bash
npm ci
npm run check
npm test
npm run package
npm run test:scan
npm run scan:secrets
```

Default documentation files are in English; `*.zh-CN.md` files provide the complete Simplified Chinese versions. The component VSIX files and optional offline ZIP include both languages. Command Palette titles in the extension remain Chinese, as shown in this guide.

Outputs in `dist/` are the main VSIX, optional ZIP, and SHA-256 checksums. The remote component is built first as `local/assets/remote.vsix`, then embedded in the main VSIX; this generated directory is excluded from Git. Packaging verifies both components' identities, hosts, versions, source contents, archive allowlists, and checksums. Packaging uses an explicit file allowlist. The scanner explicitly unpacks nested release archives and checks source files, personal paths, private-network addresses, sensitive filenames, and available Git history without printing matched values. `test:scan` uses synthetic keys to verify rejection and redaction in plain files, nested VSIX archives, and worktree history. CI follows the same process.

Tests use temporary configuration, simulated upstream services, and a JSON command channel. They cover authentication isolation for both protocols, model discovery, configuration backups, single-entry installation, Claude configuration and shell arguments, streaming, concurrency, cancellation, timeouts, and loopback restrictions. The installer follows VS Code's public command and extension-host implementation; simulated API calls and nested packaging have been verified. Specific editor and provider combinations still need an actual model call.

See [Contributing](CONTRIBUTING.md) and the [Changelog](CHANGELOG.md). This project is licensed under [MIT](LICENSE). Both extensions retain the `vectory-local` publisher ID for compatibility with existing installations.

Installation references: [VS Code extension placement](https://code.visualstudio.com/api/references/extension-manifest) and [built-in commands](https://code.visualstudio.com/api/references/commands).

Further reading: [Local component](local/README.md), [Remote component](remote/README.md), [VS Code extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host), [cross-host communication](https://code.visualstudio.com/api/advanced-topics/remote-extensions), [Codex configuration](https://developers.openai.com/codex/config-advanced), and [CC Switch](https://github.com/farion1231/cc-switch).
