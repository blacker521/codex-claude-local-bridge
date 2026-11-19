# Codex Local Bridge · Remote

[English](README.md) | 简体中文

版本 **0.3.1**。此远程组件由主插件内置并安装到 Remote-SSH 服务器，为官方 Codex 和 Claude Code 提供回环 API，经编辑器远程通道交给本机 Local 扩展和 CC Switch。可与 [SSH PassBridge](https://github.com/blacker521/ssh-passbridge) 并用，不修改 SSH wrapper、`remote.SSH.path` 或 SSH 凭据。

完整安装说明和单文件安装包见 [项目首页](https://github.com/blacker521/codex-claude-local-bridge/blob/main/README.zh-CN.md) 与 [Releases](https://github.com/blacker521/codex-claude-local-bridge/releases)。本项目是社区伴随扩展，不包含或修改官方 Codex。

## 快速接入

1. 本机 CC Switch 开启 Codex 路由和代理，选择可用供应商。
2. 安装单个 `codex-local-bridge-0.3.1.vsix` 主插件，打开目标远程窗口，点击安装提示或执行 **`Codex Local Bridge: 安装或更新远程组件`**。无需单独下载本组件。
3. 重载窗口，用 `Developer: Show Running Extensions` 核对两端位置。
4. 在远程窗口运行 **`Codex Local Bridge: 检查本机出口`**，再运行 **`Codex Local Bridge: 配置远程 Codex`**。
5. 检查弹窗中的模型、路径、provider 和桥接地址，选择“备份并配置”。
6. 执行 `Developer: Reload Window`，在官方 Codex 侧栏**新建对话**。

配置路径取远程扩展宿主的 `CODEX_HOME/config.toml`，默认远程 `~/.codex/config.toml`，需与 Codex app-server 使用的目录一致。配置命令更新顶层模型和自有 provider 段，清理该段旧认证设置，保留其他配置。已有文件先备份为 `0600`；备份可能含旧秘密，请妥善保管。新建配置目录为 `0700`，文件为 `0600`。

仅自动处理可确认的常见单行 TOML。复杂语法或活动 profile 覆盖模型时提供手动配置入口；文件在确认期间变化时停止。手动方式运行 **“选择模型并显示配置”**，合入完整片段：

```toml
# 顶层设置，放在任何 [表名] 之前；使用实际模型 ID。
model = "your-model-id"
model_provider = "vscode_local_bridge"

[model_providers.vscode_local_bridge]
name = "VS Code Local Bridge"
base_url = "http://127.0.0.1:35721/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
```

服务器无需 Codex 登录、API Key、桥接令牌或本机 `auth.json`。SSH 登录仍照常认证。升级时安装新版主 VSIX，再执行“安装或更新远程组件”，按提示重载并新建对话。手动升级须删除旧桥接段中的 `experimental_bearer_token`、`env_key`、`auth` 和 Authorization 头。

主插件和本组件仍有不同的扩展 ID，分别运行在本机和服务器；用户只需要获取一个 VSIX。安装操作使用编辑器内置命令，不依赖远程服务器访问扩展市场，不会自动重载。若编辑器不支持，可从本机主插件目录取出 `assets/remote.vsix` 手动安装。每台服务器分别保留组件，卸载时需按需处理。

## Claude Code 接入

本机 CC Switch 需另行开启 Claude 路由，配置有效的 API / Bearer 供应商。远程运行“检查 Claude 出口”和“显示远程 Claude 配置”，输入该路由实际支持的模型 ID，将生成片段合入当前服务器的远程用户设置 JSON。保存后重载窗口，在官方 Claude Code 侧栏新建对话，用 `/status` 确认 `ANTHROPIC_BASE_URL` 是服务器桥接 origin（不含 `/v1`）。

生成片段使用 `claudeCode.environmentVariables` 和 `claudeCode.disableLoginPrompt`，只展示、不自动写文件。已有环境数组按 name 更新，保留无关项；NO_PROXY 合并回环地址。远程 Claude 用户或项目 settings 中同名 env 可能覆盖启动环境，请处理旧地址、认证和云平台路由冲突；本插件不修改或绕过组织策略。公开占位值 `PROXY_MANAGED` 不是真实 Key，远程认证头会被移除，实际 Key 由本机 CC Switch 管理。

也可运行“打开远程 Claude 终端”，要求远程 PATH 中已有 `claude`；以环境和单次 `--settings` 参数启动，不写持久设置。组织或项目强制配置可能影响结果，使用 `/status` 核实。

Claude 模型设置独立于 Codex；本机 ChatGPT 登录不会用于 Claude 请求。不读取或刷新 Claude Pro / Max 订阅登录。本版本支持 Messages JSON / SSE / 工具调用正文与 `?beta=true`，count_tokens 原样转发，是否支持由 CC Switch 和上游决定；不包含额外账户、文件或搜索端点。

## 命令与设置

命令前缀均为 `Codex Local Bridge:`。

| 命令 | 用途 |
| --- | --- |
| 启动远程桥接 / 停止远程桥接 | 控制回环代理 |
| 检查本机出口 | 检查链路与本机认证解析模式，不发送模型推理请求 |
| 配置远程 Codex | 确认、备份后更新远程用户配置 |
| 显示现有 Codex 的配置片段 | 自动采用模型后展示手动配置 |
| 选择模型并显示配置 | 主动选择模型后展示配置 |
| 打开远程 Codex 终端 | 用单次进程配置运行服务器 PATH 中的 `codex` |
| 检查 Claude 出口 | 检查健康链路，不读取 Codex 登录 |
| 显示远程 Claude 配置 | 生成官方侧栏的远程用户设置片段 |
| 打开远程 Claude 终端 | 用单次进程配置运行远程 `claude` |

| 远程设置 | 默认值 |
| --- | --- |
| `codexLocalBridge.remotePort` | `35721`，修改后需重新配置 Codex |
| `codexLocalBridge.autoStart` | `true` |
| `codexLocalBridge.model` | 空，自动发现；非空时显式覆盖 Codex 模型 |
| `codexLocalBridge.claudeModel` | 空，Claude 命令会询问；非空时显式指定 Claude 模型 |

模型依次来自本机 CC Switch 模型目录、本机 Codex 顶层模型、当前供应商成功历史，支持手动输入。历史回退需本机 Python 3。认证和模型发现分开处理；健康检查或模型发现成功不保证真实模型请求可用。

以下本机 `authentication` 仅用于 Codex，默认 `auto`，读取可用的本机 ChatGPT 文件登录，否则使用由 CC Switch 管理的第三方占位认证。官方账号需本机文件登录账号和目录与 CC Switch 一致；桥接不刷新登录，不支持纯钥匙串登录。

## 排错与安全

- 找不到新命令：运行主插件的“安装或更新远程组件”，核对当前配置档案和远程环境，按提示重载。
- 旧令牌 401：核对两端安装位置、版本与当前监听进程，替换完整 provider 后新建对话。
- 官方供应商拒绝占位认证：检查本机 `auto` / `local-chatgpt` 与文件登录，服务器无需新增登录。
- 诊断通过但侧栏失败：检查实际远程 `CODEX_HOME`、模型 ID 和 provider，重载后新建对话；检查供应商错误。
- 端口占用：关闭该服务器其他桥接窗口，或修改端口后重新配置。

远程代理只监听 `127.0.0.1`，默认免认证。**同机可连接该端口的其他用户或进程也可能发起模型请求，请仅用于受信任服务器，不要暴露公网。** 需信任工作区、编辑器与扩展，保持窗口及本机 CC Switch 运行；断线或重载会中断请求。

支持 HTTP / SSE，关闭 WebSocket；同一服务器和端口只运行一个桥接窗口。网络代理环境下，应让 app-server 对 `127.0.0.1,localhost,::1` 直连。不要将 CC Switch 的模型地址填入 `HTTP_PROXY`。

更多边界见 [安全说明](https://github.com/blacker521/codex-claude-local-bridge/blob/main/SECURITY.zh-CN.md)。以 MIT 许可证开源。
