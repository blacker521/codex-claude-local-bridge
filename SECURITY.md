# Security

English | [简体中文](SECURITY.zh-CN.md)

## Trust boundaries

Codex Local Bridge sends remote Codex / Claude Code model requests through the editor's remote connection to CC Switch on your computer. Prompts, context and responses pass through these components and the selected model provider.

- The local upstream must be an HTTP(S) loopback origin. External hosts, URL paths and URL user information are rejected; redirects are not followed.
- The remote proxy listens only on `127.0.0.1` and requires no authentication by default. Other users or processes on that server that can reach the port may invoke models and consume quota. Use a trusted server and do not expose the port.
- The extensions require a trusted workspace. The editor, other extensions, remote host and CC Switch must also be trusted.
- Only allowed methods and model paths are forwarded, with limits on request size, sessions and chunks.

## Single VSIX installation

The main extension embeds a matching remote VSIX. It calls the editor's built-in installer only after you click the installation prompt or run `Codex Local Bridge: 安装或更新远程组件` (install or update the remote component). The package URI is fixed to the main extension's installation directory; it is not downloaded from a workspace or taken from a custom path. The editor may show its own trust or installation prompts.

A remote version command checks readiness after installation. If the component is not active, the extension asks you to reload manually; it does not reload automatically. Uninstalling the main extension does not guarantee removal of components from each remote host.

## Credentials and local files

Authentication headers from the server are removed. The access token and account ID from the local ChatGPT file login are used only for local requests to CC Switch, and are not returned through cross-host commands. CC Switch injects third-party provider keys.

Claude requests skip ChatGPT login resolution and always use CC Switch-managed authentication. Even if a local caller accidentally supplies trusted Codex authentication headers, they are not applied to Claude requests. This version does not read or refresh Claude subscription logins. The bridge does not refresh logins, read SSH passwords or modify SSH configuration.

`Codex Local Bridge: 配置远程 Codex` (configure remote Codex) updates the remote configuration after preview and confirmation. Existing files are first backed up with mode `0600`; new configuration files use `0600`. **Backups may contain old keys or other sensitive settings.** Store or remove them appropriately and do not upload them. Complex or ambiguous TOML requires manual editing. File locks and comparisons before writing prevent common concurrent overwrites; they do not isolate the configuration from a malicious process on the same host.

The model-history fallback uses a Python SQLite read-only connection. SQLite WAL/shared-memory management may still create auxiliary files. The extension does not export the database or complete provider configurations.

The Claude sidebar configuration command only displays a snippet and does not write editor settings. The CLI command sets routing through a per-process environment and arguments without changing persistent configuration. `PROXY_MANAGED` is a public placeholder, not a password. The model bridge does not handle network connections made by web access, MCP or other tools themselves.

## Reporting a vulnerability

Do not include credentials, prompts, model responses, private network addresses or full personal paths in public issues, pull requests, logs or screenshots. Report non-sensitive problems in repository issues with reproducible synthetic examples. For active credentials or exploit details, use GitHub's private **Report a vulnerability** entry when available; never paste active secrets into public pages.

If credentials have already been exposed, revoke or rotate them with the service first. Deleting the text does not invalidate an exposed credential.

## Publication checks

`npm run scan:secrets` uses Gitleaks to scan source files, release archives and available Git history. It also checks sensitive filenames, personal paths and private network addresses. Reports hide matched values. Scanning cannot prove the absence of all sensitive information: also review the staged file list, archive contents and example data. Runtime settings, authentication files, logs, databases and backups are not publication inputs.
