# Codex Local Bridge

让服务器上的 Codex 经由本机 CC Switch 访问模型。继续使用官方 Codex 的 VS Code / Cursor 侧栏，文件编辑与命令执行仍在服务器上完成。

**当前版本：0.2.0。服务器无需 Codex 登录、API Key 或桥接令牌，供应商认证留在本机。** SSH 登录使用原有方式，可同时使用 [SSH PassBridge](https://github.com/blacker521/ssh-passbridge)。本项目是社区维护的伴随扩展，不包含或修改官方 Codex 扩展，也不代表 OpenAI、VS Code、Cursor 或 CC Switch 官方。

```text
服务器：官方 Codex 扩展 / Codex CLI
                    ↓
         http://127.0.0.1:35721/v1
                    ↓ Remote 扩展
       VS Code / Cursor 已建立的远程连接
                    ↓ Local 扩展
本机：        CC Switch → 模型供应商
```

桥接复用编辑器的远程连接，服务器无需直连本机 IP，也无需新增 SSH `-R` 转发。本机扩展只接受回环地址的 CC Switch 服务，远程 API 只监听服务器 `127.0.0.1`。

## 快速开始

### 1. 准备环境

- 使用桌面版 VS Code / Cursor，通过 Remote-SSH 打开服务器目录，并信任该工作区。
- 安装官方 Codex 扩展，确认远程窗口中它的扩展宿主运行在服务器上。
- 本机 CC Switch 已配置可用供应商，并已开启 Codex 路由及代理服务。
- 桥接扩展要求 VS Code `1.85+`；官方 Codex 扩展的版本要求需单独满足。Cursor 等兼容编辑器还需支持跨扩展宿主命令调用。

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

### 2. 安装两端扩展

从 [Releases](https://github.com/blacker521/codex-local-bridge/releases) 下载 **`codex-local-bridge-0.2.0.zip`**，解压后包含两个 VSIX、使用说明、许可证和校验文件；也可以分别下载 VSIX。

| 安装包 | 安装位置 | 作用 |
| --- | --- | --- |
| `codex-local-bridge-local-0.2.0.vsix` | 电脑本机 | 访问 CC Switch、加载本机认证、发现模型 |
| `codex-local-bridge-remote-0.2.0.vsix` | Remote-SSH 服务器 | 为远程 Codex 提供回环 API |

1. 通过命令面板 `Extensions: Install from VSIX...` 在当前编辑器配置档案中安装 Local。
2. 打开目标服务器的 Remote-SSH 窗口，在该窗口安装 Remote，核对安装位置为目标 SSH 主机。必要时先把 Remote VSIX 上传到服务器。
3. 执行 `Developer: Reload Window`，再用 `Developer: Show Running Extensions` 确认 Local 在本机、Remote 在服务器。

使用命名配置档案时，两端都需要安装到**当前窗口使用的档案**。磁盘中存在新版目录，不能证明当前窗口已启用新版。

发布页的 `SHA256SUMS-0.2.0.txt` 可验证两个 VSIX 和 ZIP。解压目录内的同名文件只校验随包附带的两个 VSIX。在对应文件目录执行：

```bash
# Linux
sha256sum -c SHA256SUMS-0.2.0.txt
# macOS
shasum -a 256 -c SHA256SUMS-0.2.0.txt
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

## 认证与信任边界

供应商认证发生在本机 Local 扩展到 CC Switch 的请求中，不进入跨端命令或远程配置。

| 本机设置 `codexLocalBridge.authentication` | 行为 |
| --- | --- |
| `auto`（默认） | 有本机 ChatGPT 文件登录时加载它；没有时使用占位值 `PROXY_MANAGED`，由 CC Switch 注入第三方 Key |
| `proxy-managed` | 不读取登录文件，适用于纯第三方 API 路由 |
| `local-chatgpt` | 要求可用的本机 ChatGPT 文件登录 |

CC Switch 官方账号路由需要真实 ChatGPT 登录。本机扩展只读取本机 `auth.json` 的 access token 与 account ID，并只用于发往本机 CC Switch 的请求。**本机文件账号应与 CC Switch 所选官方账号一致。** 目录依次取本机设置 `codexLocalBridge.codexHome`、本机 `CODEX_HOME`、`~/.codex`。设置自定义目录时使用绝对路径。桥接不刷新或写入登录文件；仅存于钥匙串的登录目前不支持。

远程代理默认免认证。**同一服务器上能够连接该回环端口的其他用户或进程，也可能发起模型请求。** 请用于受信任的远程主机，不要将此端口转发或绑定到公网。本机 CC Switch、远程工作区、编辑器及其扩展都是信任边界的一部分。请求内容会经本机和所选供应商处理。详见 [安全说明](SECURITY.md)。

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
| 查看本机状态 | 查看本机 CC Switch 地址、会话数与协议版本 |
| 启动远程桥接 / 停止远程桥接 | 控制服务器回环代理 |
| 检查本机出口 | 检查链路和本机认证模式，不发送模型推理请求 |
| 配置远程 Codex | 预览、确认、备份后更新远程用户配置 |
| 显示现有 Codex 的配置片段 | 自动选择模型后展示手动配置片段 |
| 选择模型并显示配置 | 主动选择模型后展示手动配置片段 |
| 打开远程 Codex 终端 | 用单次进程配置启动远程 `codex` CLI |

CLI 命令要求服务器 PATH 中已有 `codex`；官方侧栏不要求此条件。远程端口可用 `codexLocalBridge.remotePort` 修改，默认 `35721`。修改后需重新配置 Codex。`codexLocalBridge.autoStart` 默认 `true`。

## 升级与排错

升级时在当前配置档案的两端安装同一版本，重载窗口，再运行“配置远程 Codex”。从旧令牌版本手动升级时，完整替换桥接 provider 段，删除其中旧的 `experimental_bearer_token`、`env_key`、`auth` 和 Authorization 头设置；保留 `requires_openai_auth = false`。随后新建对话。

| 现象 | 检查方式 |
| --- | --- |
| 找不到配置或模型选择命令 | 核对当前远程窗口的 Remote 扩展为 `0.2.0`，确认安装档案和位置后重载 |
| 提示“桥接令牌无效” | 可能仍运行旧版进程；核对两端版本、监听端口与旧配置，重新安装并重载 |
| 官方供应商仍按第三方配置请求 | 检查本机认证为 `auto` 或 `local-chatgpt`，文件登录目录和账号与 CC Switch 一致 |
| 配置命令要求手动处理 | 复杂 TOML 或 profile 覆盖需要人工合并；使用生成片段并保留其他设置 |
| 端口已占用 | 关闭该服务器的其他桥接窗口，或更改端口后重新配置 |
| 健康检查成功但对话失败 | 检查模型 ID、实际 `CODEX_HOME`、provider 与供应商返回的错误；用新对话验证 |
| 终端可用但侧栏失败 | 确认 app-server 读取了更新后的远程配置；若使用网络代理，确保 `NO_PROXY` 含 `127.0.0.1,localhost,::1` |

CC Switch 的地址是模型供应商 `base_url`，不要把它填入 `HTTP_PROXY` 或 VS Code `http.proxy`。分享诊断前删除提示词、响应、账号、Key 和本机路径。

## 运行范围

需保持本机 CC Switch 和远程窗口运行，断线或重载会中断请求。同一服务器、同一监听端口同时使用一个桥接窗口。本项目不修改 `remote.SSH.path`、SSH wrapper 或 SSH 凭据，可与 SSH PassBridge 并用。

支持 HTTP / SSE，以及 `/health`、`/v1/models`、`/v1/responses`、`/v1/responses/compact`；服务器另有 `/bridge/auth-check` 诊断接口。每个窗口最多 8 个会话，请求体上限 32 MiB，跨端块上限 64 KiB，空闲与单次 RPC 等待有超时，持续 SSE 无固定总时长限制。WebSocket、额外多媒体路径、独立搜索端点和断线续传尚未实现。

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

输出位于 `dist/`：两个 VSIX、单个 ZIP 和 SHA-256 校验文件。打包使用显式文件白名单，扫描会显式展开嵌套发布包，检查源码、个人路径、私网地址、敏感文件名及可用的 Git 历史，报告不输出匹配值。`test:scan` 使用合成假密钥验证普通文件、嵌套 VSIX 和 worktree 历史的拒绝与脱敏。CI 执行同一流程。

测试使用临时配置、模拟上游与 JSON 命令通道，覆盖认证隔离、模型发现、配置备份和保守更新、流式传输、并发、取消、超时和回环限制；实际编辑器与供应商组合仍需实际调用验证。

参与开发见 [贡献指南](CONTRIBUTING.md)，版本变化见 [CHANGELOG](CHANGELOG.md)。项目以 [MIT](LICENSE) 开源。两端扩展保留 `vectory-local` publisher ID，以兼容已有安装。

进一步阅读：[本机端](local/README.md)、[远程端](remote/README.md)、[VS Code 扩展宿主](https://code.visualstudio.com/api/advanced-topics/extension-host)、[跨宿主通信](https://code.visualstudio.com/api/advanced-topics/remote-extensions)、[Codex 配置](https://developers.openai.com/codex/config-advanced)、[CC Switch](https://github.com/farion1231/cc-switch)。
