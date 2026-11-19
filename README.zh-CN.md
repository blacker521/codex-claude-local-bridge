# Codex & Claude Local Bridge

[English](README.md) | 简体中文

让服务器上的 **Codex 与 Claude Code** 经由本机 CC Switch 访问模型。使用同一个 VSIX 安装入口，继续使用两者的官方 VS Code / Cursor 侧栏，文件编辑与命令执行仍在服务器上完成。

**当前版本：0.3.1。服务器无需为桥接保存真实供应商 Key 或登录，供应商认证留在本机。Codex 回环 API 免认证，Claude 使用公开占位值进入网关模式。** SSH 登录使用原有方式，可同时使用 [SSH PassBridge](https://github.com/blacker521/ssh-passbridge)。本项目是社区维护的伴随扩展，不包含或修改官方 Codex / Claude Code 扩展，也不代表 OpenAI、Anthropic、VS Code、Cursor 或 CC Switch 官方。

```text
服务器：官方 Codex / Claude Code 扩展或 CLI
                    ↓
         http://127.0.0.1:35721
       Codex: /v1/responses
       Claude: /v1/messages
                    ↓ Remote 扩展
       VS Code / Cursor 已建立的远程连接
                    ↓ Local 扩展
本机：        CC Switch → 模型供应商
```

桥接复用编辑器的远程连接，服务器无需直连本机 IP，也无需新增 SSH `-R` 转发。本机扩展只接受回环地址的 CC Switch 服务，远程 API 只监听服务器 `127.0.0.1`。

## 快速开始

### 1. 准备环境

- 使用桌面版 VS Code / Cursor，通过 Remote-SSH 打开服务器目录，并信任该工作区。
- 按需安装官方 Codex 或 Claude Code 扩展，确认远程窗口中它运行在服务器上。
- 本机 CC Switch 已配置可用供应商，开启对应的 Codex / Claude 路由及代理服务。可同时开启，两者分别使用 CC Switch 中各自的供应商。
- 桥接扩展要求 VS Code `1.85+`；官方扩展的版本要求需单独满足（Claude Code 扩展要求 VS Code `1.94+`）。Cursor 等兼容编辑器还需支持跨扩展宿主命令调用。

插件默认连接 `http://127.0.0.1:2900`。**这是插件默认值，CC Switch 实际端口以其设置为准。** 在本机用户设置中修改：

```json
{
  "codexLocalBridge.upstreamOrigin": "http://127.0.0.1:2900",
  "codexLocalBridge.authentication": "auto"
}
```

可在本机检查服务：

```bash
curl --noproxy '*' --max-time 5 http://127.0.0.1:2900/health
```

### 2. 安装一个 VSIX

从 [Releases](https://github.com/blacker521/codex-claude-local-bridge/releases) 下载 **`codex-local-bridge-0.3.1.vsix`**，通过命令面板 `Extensions: Install from VSIX...` 安装。它是本机主插件，并内置与之匹配的远程组件，不需要另下第二个 VSIX，也不依赖扩展市场下载远程组件。

1. 在当前编辑器配置档案安装主插件，然后打开目标服务器的 Remote-SSH 窗口。
2. 若首次提示缺少远程组件，选择“安装远程组件”；也可以主动执行 **`Codex Local Bridge: 安装或更新远程组件`**。
3. 编辑器将内置组件安装到当前远程环境。按提示执行 `Developer: Reload Window`，再检查出口。
4. 使用 `Developer: Show Running Extensions` 可确认主插件在本机、Remote 组件在服务器。

**一个 VSIX 统一安装入口，底层仍有两个扩展组件。** VS Code 为每个扩展选择一个运行位置，本项目需要同时执行本机出口与服务器回环代理，不能简单把两个 manifest 合成一个。主插件保留旧 Local 的扩展 ID，远程组件也保留原 ID，以兼容升级；扩展列表中仍可看到两者。

安装远程组件需要你点击提示或执行命令，不会在后台静默安装，也不会自动重载。安装命令会检查远程组件版本，同版或更高版本不会降级覆盖；安装完成但组件尚未激活时会提示重载，后续可再次检查。每台远程主机都需要安装它自己的组件。使用命名配置档案时，在当前窗口使用的档案中操作。

若编辑器不支持内置 VSIX 安装命令，可从主插件的本机安装目录取出 `assets/remote.vsix`，通过远程窗口的 `Extensions: Install from VSIX...` 手动安装。无需改 SSH 配置或复制认证文件。

可选的 **`codex-local-bridge-0.3.1.zip`** 包含主 VSIX、使用说明、许可证与校验文件。发布页的 `SHA256SUMS-0.3.1.txt` 校验主 VSIX 和 ZIP；解压目录内的同名文件只校验主 VSIX。在对应文件目录执行：

```bash
# Linux
sha256sum -c SHA256SUMS-0.3.1.txt
# macOS
shasum -a 256 -c SHA256SUMS-0.3.1.txt
```

### 3. 配置远程 Codex

在目标远程窗口依次执行：

1. **`Codex Local Bridge: 检查本机出口`**。
2. **`Codex Local Bridge: 配置远程 Codex`**。插件自动发现模型，必要时让你选择或输入实际模型 ID。
3. 检查弹窗中的远程配置路径、模型、provider 与桥接地址，再选择“备份并配置”。
4. 执行 `Developer: Reload Window`，在官方 Codex 侧栏**新建对话**测试。

配置命令使用远程扩展宿主的 `CODEX_HOME/config.toml`，默认远程 `~/.codex/config.toml`。请确认与 Codex app-server 实际使用的目录一致。它更新顶层 `model`、`model_provider` 和自己的 provider 段，清理该段的旧认证字段，保留其他配置。写入前会创建权限为 `0600` 的原文件备份；**备份可能包含原配置的敏感值，请妥善保管，不要提交到仓库或 issue。** 新建目录权限为 `0700`，配置文件为 `0600`。

自动更新器只处理它能确认的常见单行 TOML 语法。多行字符串、数组表、活动 profile 覆盖模型等情况会停止并提供手动配置入口；不会猜测修改。若文件在确认期间发生变化，会要求重新检查。

手动配置时运行 **`Codex Local Bridge: 选择模型并显示配置`**，将完整片段合入远程用户配置。示例中的模型需换成实际 ID：

```toml
# 放在任何 [表名] 之前；替换已有同名项，避免重复定义。
model = "your-model-id"
model_provider = "vscode_local_bridge"

[model_providers.vscode_local_bridge]
name = "VS Code Local Bridge"
base_url = "http://127.0.0.1:35721/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
```

旧对话可能保留原 provider，重载窗口不会自动切换旧对话。服务器不需要复制本机 `auth.json` 或运行 `codex login`。

## 接入 Claude Code

Claude 与 Codex 共用桥接端口；在 CC Switch 中**另行开启 Claude 路由**并选择已有有效 API / Bearer Key 的供应商。Claude 不会自动使用 Codex 的模型或读取 ChatGPT 登录。本版本不读取、刷新或转发本机 Claude Pro / Max 订阅登录。

### 官方 Claude Code 侧栏

1. 安装或更新远程组件，并在远程环境安装官方 Claude Code 扩展。
2. 执行 **`Codex Local Bridge: 检查 Claude 出口`**，再执行 **`Codex Local Bridge: 显示远程 Claude 配置`**。
3. 输入 CC Switch **Claude 路由**实际支持的模型 ID。也可设置远程 `codexLocalBridge.claudeModel`，避免每次输入；此设置独立于 Codex 模型。
4. 将生成的 JSONC 片段合入**当前服务器的远程用户设置 JSON**。不要整文件覆盖；已有 `claudeCode.environmentVariables` 时按 `name` 更新，保留无关条目。若已有 `NO_PROXY`，保留原列表并加入回环地址。
5. 执行 `Developer: Reload Window`，在 Claude Code 侧栏新建对话，用 `/status` 核对 Anthropic base URL 为 `http://127.0.0.1:35721`。

最小配置示例，模型须改成实际 ID；完整命令生成的片段还会清空其他云平台路由选择和旧认证变量，以避免冲突：

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

`ANTHROPIC_BASE_URL` 是 **origin，不加 `/v1`**。`PROXY_MANAGED` 是公开占位值，不是真实 Key；远程代理会移除它，真正的供应商凭据由本机 CC Switch 注入。无需在服务器执行 `/login`。官方扩展启动前的登录检查读取 `claudeCode.environmentVariables`，只写远程 `~/.claude/settings.json` 可能仍出现登录提示，见 [Claude 官方网关接入说明](https://code.claude.com/docs/en/llm-gateway-connect#vs-code-extension)。

本命令只展示片段，不自动修改 Claude、编辑器或 SSH 配置。远程 `~/.claude/settings.json` 或项目设置中的同名 `env` 可能覆盖扩展启动环境，请处理旧的地址、认证和云平台选择冲突；组织策略优先级更高，本插件不修改或绕过它。生成片段将 Haiku / Sonnet / Opus 档位暂时映射到所选 ID，可按供应商支持情况分别调整。它同时建议关闭非必要的 Claude 网络流量；外部 MCP、网页访问等工具的网络请求不经过模型桥接。

### Claude Code CLI

运行 **`Codex Local Bridge: 打开远程 Claude 终端`**。服务器 PATH 中需已有 `claude`；命令通过终端环境与单次 `--settings` 参数设置网关地址、占位认证和模型，保留原 `NO_PROXY` 列表，不改持久配置。项目或组织强制设置可能覆盖路由，需用 `/status` 确认；本插件不会绕过组织策略。

支持 Anthropic Messages JSON、工具调用正文、SSE 与精确的 `?beta=true` 查询。`/v1/messages/count_tokens` 会原样交给 CC Switch，**是否支持取决于 CC Switch 和供应商版本**；上游 404 原样返回，不伪造计数。额外的登录、账户、搜索、文件等路径未实现。

## 认证与信任边界

供应商认证发生在本机 Local 扩展到 CC Switch 的请求中，不进入跨端命令或远程配置。以下 `authentication` 设置仅影响 Codex；Claude 始终使用 CC Switch 托管认证，并跳过本机 ChatGPT 登录读取。

| 本机设置 `codexLocalBridge.authentication` | 行为 |
| --- | --- |
| `auto`（默认） | 有本机 ChatGPT 文件登录时加载它；没有时使用占位值 `PROXY_MANAGED`，由 CC Switch 注入第三方 Key |
| `proxy-managed` | 不读取登录文件，适用于纯第三方 API 路由 |
| `local-chatgpt` | 要求可用的本机 ChatGPT 文件登录 |

CC Switch 官方账号路由需要真实 ChatGPT 登录。本机扩展只读取本机 `auth.json` 的 access token 与 account ID，并只用于发往本机 CC Switch 的请求。**本机文件账号应与 CC Switch 所选官方账号一致。** 目录依次取本机设置 `codexLocalBridge.codexHome`、本机 `CODEX_HOME`、`~/.codex`。设置自定义目录时使用绝对路径。桥接不刷新或写入登录文件；仅存于钥匙串的登录目前不支持。

远程代理默认免认证。**同一服务器上能够连接该回环端口的其他用户或进程，也可能发起模型请求。** 请用于受信任的远程主机，不要将此端口转发或绑定到公网。本机 CC Switch、远程工作区、编辑器及其扩展都是信任边界的一部分。请求内容会经本机和所选供应商处理。详见 [安全说明](SECURITY.zh-CN.md)。

## 自动获取模型 ID

远程设置 `codexLocalBridge.model` 非空时优先使用它。留空时，本机按顺序查找，前一来源无可用结果才回退：

1. CC Switch `/v1/models`，支持 OpenAI `data[].id` 和 Codex `models[].slug`。
2. 本机 Codex 配置的顶层 `model`。
3. CC Switch 当前 Codex 供应商最近成功请求的模型 ID。此回退需要本机 Python 3；默认数据库为 `~/.cc-switch/cc-switch.db`，可通过 `codexLocalBridge.ccSwitchHome` 指定目录。
4. 手动输入。

展示名称不会被推测成模型 ID。历史候选不保证当前权限、配额或路由仍然有效。模型发现只提取模型元数据；目录请求使用占位认证，模型目录或历史回退成功不等于供应商认证成功。

普通配置命令会采用候选中的当前模型或唯一候选；多个候选时展示选择框。“选择模型并显示配置”始终允许主动选择。

## 常用命令

以下命令在目标远程窗口运行；“查看本机状态”由 Local 提供。

| 命令前缀 `Codex Local Bridge:` | 用途 |
| --- | --- |
| 安装或更新远程组件 | 从主插件内置包安装或更新当前远程环境 |
| 查看本机状态 | 查看本机 CC Switch 地址、会话数与协议版本 |
| 启动远程桥接 / 停止远程桥接 | 控制服务器回环代理 |
| 检查本机出口 | 检查链路和本机认证模式，不发送模型推理请求 |
| 配置远程 Codex | 预览、确认、备份后更新远程用户配置 |
| 显示现有 Codex 的配置片段 | 自动选择模型后展示手动配置片段 |
| 选择模型并显示配置 | 主动选择模型后展示手动配置片段 |
| 打开远程 Codex 终端 | 用单次进程配置启动远程 `codex` CLI |
| 检查 Claude 出口 | 只检查健康链路，不读取 Codex 登录或发送模型推理 |
| 显示远程 Claude 配置 | 生成官方侧栏所需的远程用户设置片段 |
| 打开远程 Claude 终端 | 用单次进程配置运行服务器上的 `claude` |

CLI 命令要求服务器 PATH 中已有 `codex`；官方侧栏不要求此条件。远程端口可用 `codexLocalBridge.remotePort` 修改，默认 `35721`。修改后需重新配置 Codex。`codexLocalBridge.autoStart` 默认 `true`。

## 升级与排错

从 0.2.x 升级时，只需安装新版主 VSIX，它会更新原来的 Local 扩展；打开远程窗口后执行“安装或更新远程组件”。重载窗口，再运行“配置远程 Codex”。主插件卸载后，远程组件可能仍保留在各服务器，需按需分别卸载。从旧令牌版本手动升级时，完整替换桥接 provider 段，删除其中旧的 `experimental_bearer_token`、`env_key`、`auth` 和 Authorization 头设置；保留 `requires_openai_auth = false`。随后新建对话。

| 现象 | 检查方式 |
| --- | --- |
| 找不到配置或模型选择命令 | 运行“安装或更新远程组件”，核对当前档案和远程安装位置后重载 |
| 提示“桥接令牌无效” | 可能仍运行旧版进程；核对两端版本、监听端口与旧配置，重新安装并重载 |
| 官方供应商仍按第三方配置请求 | 检查本机认证为 `auto` 或 `local-chatgpt`，文件登录目录和账号与 CC Switch 一致 |
| 配置命令要求手动处理 | 复杂 TOML 或 profile 覆盖需要人工合并；使用生成片段并保留其他设置 |
| 端口已占用 | 关闭该服务器的其他桥接窗口，或更改端口后重新配置 |
| 健康检查成功但对话失败 | 检查模型 ID、实际 `CODEX_HOME`、provider 与供应商返回的错误；用新对话验证 |
| 终端可用但侧栏失败 | 确认 app-server 读取了更新后的远程配置；若使用网络代理，确保 `NO_PROXY` 含 `127.0.0.1,localhost,::1` |

CC Switch 的地址是模型供应商 `base_url`，不要把它填入 `HTTP_PROXY` 或 VS Code `http.proxy`。分享诊断前删除提示词、响应、账号、Key 和本机路径。

## 运行范围

需保持本机 CC Switch 和远程窗口运行，断线或重载会中断请求。同一服务器、同一监听端口同时使用一个桥接窗口。本项目不修改 `remote.SSH.path`、SSH wrapper 或 SSH 凭据，可与 SSH PassBridge 并用。

支持 HTTP / SSE，以及 `/health`、`/v1/models`、`/v1/responses`、`/v1/responses/compact`、`/v1/messages`、`/v1/messages/count_tokens`，两个 Messages 路径另支持精确的 `?beta=true`；服务器另有 `/bridge/auth-check` 诊断接口。每个窗口最多 8 个会话，请求体上限 32 MiB，跨端块上限 64 KiB，空闲与单次 RPC 等待有超时，持续 SSE 无固定总时长限制。WebSocket、额外多媒体路径、独立搜索端点和断线续传尚未实现。

## 开发与打包

使用 Node.js **22+**、npm 和 Python 3。扩展无第三方 Node 运行时依赖；开发打包工具通过 `package-lock.json` 锁定，无需全局安装 `vsce`。发布检查另需 [Gitleaks](https://github.com/gitleaks/gitleaks)。

```bash
npm ci
npm run check
npm test
npm run package
npm run test:scan
npm run scan:secrets
```

默认文档使用英文，`*.zh-CN.md` 提供完整简体中文版；两端 VSIX 与可选离线 ZIP 均包含两种语言。扩展实际命令名称仍为中文，可按本文名称在命令面板查找。

输出位于 `dist/`：单个主 VSIX、可选 ZIP 和 SHA-256 校验文件。远程组件先构建到 `local/assets/remote.vsix`，再内嵌到主 VSIX；该生成目录不进入 Git。打包完成后自动核对两个组件的身份、宿主、版本、源码、归档白名单和校验值。打包使用显式文件白名单，扫描会显式展开嵌套发布包，检查源码、个人路径、私网地址、敏感文件名及可用的 Git 历史，报告不输出匹配值。`test:scan` 使用合成假密钥验证普通文件、嵌套 VSIX 和 worktree 历史的拒绝与脱敏。CI 执行同一流程。

测试使用临时配置、模拟上游与 JSON 命令通道，覆盖两种协议认证隔离、模型发现、配置备份、单入口安装、Claude 配置和 Shell 参数、流式传输、并发、取消、超时和回环限制。单入口安装依据 VS Code 公开命令与宿主源码实现，已验证模拟调用与嵌套打包；具体编辑器与供应商组合仍需实际调用验证。

参与开发见 [贡献指南](CONTRIBUTING.zh-CN.md)，版本变化见 [CHANGELOG](CHANGELOG.zh-CN.md)。项目以 [MIT](LICENSE) 开源。两端扩展保留 `vectory-local` publisher ID，以兼容已有安装。

安装机制参考：[VS Code 扩展位置](https://code.visualstudio.com/api/references/extension-manifest)、[内置安装命令](https://code.visualstudio.com/api/references/commands)。

进一步阅读：[本机端](local/README.zh-CN.md)、[远程端](remote/README.zh-CN.md)、[VS Code 扩展宿主](https://code.visualstudio.com/api/advanced-topics/extension-host)、[跨宿主通信](https://code.visualstudio.com/api/advanced-topics/remote-extensions)、[Codex 配置](https://developers.openai.com/codex/config-advanced)、[CC Switch](https://github.com/farion1231/cc-switch)。
