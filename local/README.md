# Codex Local Bridge · 本机

版本 **0.2.0**。在本机安装此 Local 扩展，在 Remote-SSH 服务器安装同版本 Remote 扩展，让远程官方 Codex 的模型请求经编辑器远程通道交给本机 CC Switch。可与 [SSH PassBridge](https://github.com/blacker521/ssh-passbridge) 并用。本项目是社区伴随扩展，不包含官方 Codex。

完整安装说明和单文件安装包见 [项目首页](https://github.com/blacker521/codex-local-bridge) 与 [Releases](https://github.com/blacker521/codex-local-bridge/releases)。

## 安装与使用

1. 本机 CC Switch 开启 Codex 路由和代理，选好供应商。
2. 当前编辑器配置档案的本机侧安装 `codex-local-bridge-local-0.2.0.vsix`，目标远程窗口安装 `codex-local-bridge-remote-0.2.0.vsix`。
3. 执行 `Developer: Reload Window`，用 `Developer: Show Running Extensions` 确认 Local 在本机、Remote 在服务器。
4. 在远程窗口运行 **`Codex Local Bridge: 检查本机出口`**，再运行 **`Codex Local Bridge: 配置远程 Codex`**。
5. 确认模型和远程配置路径，选择“备份并配置”，重载窗口后在官方 Codex 侧栏**新建对话**。

复杂 TOML 会提供手动入口，可运行“选择模型并显示配置”生成片段。服务器无需 Codex 登录、API Key 或桥接令牌；SSH 登录照常认证。

## 本机设置

```json
{
  "codexLocalBridge.upstreamOrigin": "http://127.0.0.1:2900",
  "codexLocalBridge.authentication": "auto"
}
```

`2900` 是本插件默认端口，以 CC Switch 实际设置为准。上游只接受 HTTP(S) 的 `localhost`、`127.0.0.1` 或 `[::1]` origin，不带路径、用户名、查询或片段，不跟随重定向。修改地址会取消现有请求。

| 设置 | 默认值与用途 |
| --- | --- |
| `codexLocalBridge.upstreamOrigin` | `http://127.0.0.1:2900`，本机 CC Switch 地址 |
| `codexLocalBridge.authentication` | `auto`，本机认证模式 |
| `codexLocalBridge.codexHome` | 空；使用本机 `CODEX_HOME` 或 `~/.codex`，自定义时须为绝对路径 |
| `codexLocalBridge.ccSwitchHome` | 空；使用 `~/.cc-switch`，仅供模型历史回退 |

## 认证与模型

- `auto`：存在本机 ChatGPT 文件登录时加载它；没有时使用 `PROXY_MANAGED`，由 CC Switch 注入第三方 Key。
- `proxy-managed`：不读取登录文件，适合纯第三方 API。
- `local-chatgpt`：强制要求可用的本机 ChatGPT 文件登录。

官方账号路由需要本机 `auth.json` 的 `tokens.access_token` 和 `tokens.account_id`，仅用于本机到 CC Switch 的请求，凭据不返回服务器。文件目录和账号必须与 CC Switch 所选官方账号一致。桥接不写入或刷新登录，纯钥匙串登录目前不支持。服务器传来的认证头会被移除。

模型依次来自 CC Switch `/v1/models`、本机 Codex 配置顶层 `model`、CC Switch 当前 Codex 供应商最近成功请求；最后可手动输入。历史回退需要 Python 3，只表示曾成功使用，不保证当前权限。模型发现只返回模型元数据，目录请求使用占位认证；发现成功不代表官方路由认证成功。

## 诊断与边界

“查看本机状态”只显示地址、会话数和协议版本。“检查本机出口”检查链路和认证解析模式，不发送模型推理请求。

Local 不监听 TCP 端口；Remote 只监听服务器 `127.0.0.1`，默认免认证。**同机能连接此端口的用户或进程也可能调用模型，请用于受信任的服务器并勿暴露端口。** 工作区、编辑器及扩展应可信，提示词和响应会经本机与供应商处理。

支持 HTTP / SSE：GET `/health`、`/v1/models`，POST `/v1/responses`、`/v1/responses/compact`。每个 broker 最多 8 会话、请求体 32 MiB、跨端块 64 KiB，持续传输无固定总时长限制。需保持本机 CC Switch 与远程窗口运行。

升级时两端安装同一版本并重载，重新配置后新建对话。若提示旧桥接令牌错误，检查是否仍运行旧版或安装到了其他配置档案。安全说明见 [SECURITY.md](https://github.com/blacker521/codex-local-bridge/blob/main/SECURITY.md)。以 MIT 许可证开源。
