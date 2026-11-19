# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

Reproducible reports and improvements are welcome. This project is a companion bridge made of two independent extensions; it does not modify or bundle the official Codex extension.

## Development environment

- Node.js 22+, npm and Python 3.
- Install Gitleaks for publication checks; CI pins its version.
- Use `npm ci` for locked development dependencies. A global vsce installation is not required.

```bash
npm ci
npm run check
npm test
npm run package
npm run test:scan
npm run scan:secrets
```

## Layout

| Directory | Responsibility |
| --- | --- |
| `local/src/` | Loopback upstream restrictions, authentication, model discovery and streaming broker |
| `remote/src/` | HTTP proxy, cross-host commands, remote configuration and command entry points |
| `test/` | Node's built-in tests with temporary directories and simulated services |
| `scripts/` | Syntax checks, VSIX/ZIP packaging and publication scanning |

When changing the cross-host protocol, preserve JSON serialization, chunk backpressure and cancellation semantics. Never put local credentials into RPC results. Authentication changes must verify that remote authentication headers are stripped. Configuration-update changes must preserve rejection of complex syntax, confirmation before writing, backups and concurrent-change detection.

## Tests and submissions

Tests must use isolated temporary directories, synthetic credentials and simulated upstream services. Do not read a developer's real `auth.json`, CC Switch database or SSH configuration, and do not send real model requests. Add a regression test that reproduces a behavior fix. Documentation and packaging changes can be validated by inspecting their output.

The single VSIX installer must use only the fixed embedded-package URI in the main extension directory. Do not accept installation paths from workspaces, settings or command arguments. Do not use `extensions.getExtension`, which cannot see across hosts, to determine the remote version; use the side-effect-free version RPC.

Do not commit user settings, logs, databases, backups, private addresses or personal absolute paths. Use `127.0.0.1`, `your-model-id` and generic placeholder paths in examples. Replace unsafe data when scanning finds it; do not bypass checks with broad ignore rules.

A pull request should explain its concrete trigger, resulting behavior and the validation actually performed. State the scope if an editor or provider has not been verified.

## Documentation languages

Default documents are in English; `*.zh-CN.md` files provide complete Simplified Chinese versions. Keep both languages in sync when changing installation steps, commands, defaults or limitations. Command titles must match what the extension actually displays.

## Versions and releases

Keep the versions in the root, `local/` and `remote/` `package.json` files aligned, and update the lockfile and changelog. Preserve both extension IDs for upgrades. Build the remote package first, then embed it in the local main VSIX; `local/assets/` is generated and not committed.

`npm run package` includes explicitly allowed files; `dist/` is not committed. Inspect the main VSIX, its embedded remote VSIX and the optional ZIP before publication, then scan for sensitive information. Scan Git history again after committing.

The MIT license applies to original code in this repository. Check licensing and retain required notices before importing code from other projects. Follow [SECURITY.md](SECURITY.md) for security issues.
