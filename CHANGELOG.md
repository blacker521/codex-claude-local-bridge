# Changelog

English | [简体中文](CHANGELOG.zh-CN.md)

## 0.3.1

- Provide complete English and Simplified Chinese documentation, with language links and offline packaging.

## 0.3.0

- Support Claude Code through the same installation entry point: Messages / count_tokens forwarding, sidebar configuration snippets and a CLI launch command.
- Always use CC Switch-managed authentication for Claude requests, strip remote authentication headers and skip local ChatGPT login resolution. Claude subscription logins are not read.
- Replace two separate downloads with one main VSIX containing the matching remote component.
- Add `Codex Local Bridge: 安装或更新远程组件` (install or update the remote component) and an initial remote-window installation prompt. Installation starts only after a click; equal or newer versions are skipped and the window is not reloaded automatically.
- Add a side-effect-free remote version probe. Ask for a reload when installation completes but the new component is not yet active.
- Build the remote component before embedding it in the main VSIX, and verify nested package identities, extension hosts, source contents and file allowlists.
- Preserve both extension IDs, the bridge protocol and SSH PassBridge compatibility.

## 0.2.0

First public release.

- Bridge remote Codex to local CC Switch through the VS Code Remote channel, alongside SSH PassBridge.
- Provide an unauthenticated remote loopback API with provider authentication kept on the local computer. Support proxy-managed third-party credentials and local ChatGPT file login.
- Discover model IDs from the model catalog, local Codex configuration or the current provider's successful request history, with manual selection.
- Add `Codex Local Bridge: 配置远程 Codex` (configure remote Codex) to back up and update configuration after confirmation, with a manual fallback for complex TOML.
- Fix GET request-body framing and cancellation/stopping when cross-host RPC calls hang.
- Unify packaging of both VSIX files and a single ZIP with documentation and SHA-256 checksums.
- Add locked development dependencies, CI, contribution and security guidance, and sensitive-information checks for source files, Git history and archives.
