'use strict';

const vscode = require('vscode');
const http = require('node:http');
const { RemoteProxy } = require('./proxy');
const { PROVIDER, buildUpdatedConfig, resolveConfigPath, readConfig, applyConfig } = require('./configure');
const { createClaudeCommands } = require('./claude');

let current;
let starting;
let output;
let statusItem;

function rpc(method, args) {
  return vscode.commands.executeCommand(`codexLocalBridge.local.${method}`, args);
}

async function start() {
  if (!vscode.env.remoteName) throw new Error('请在已通过 Remote-SSH 打开的服务器工作区运行。');
  if (current) return current.proxy.address();
  if (starting) return starting;
  starting = (async () => {
    const local = await rpc('status');
    if (local?.protocolVersion !== 1) throw new Error('本机桥接版本不匹配，请安装对应的 Local VSIX。');
    const port = vscode.workspace.getConfiguration('codexLocalBridge').get('remotePort', 35721);
    const proxy = new RemoteProxy({ rpc, port, log: message => output.appendLine(message) });
    const address = await proxy.start();
    current = { proxy };
    statusItem.text = `$(plug) AI 本机出口 :${address.port}`;
    statusItem.tooltip = `远程 ${address.baseUrl} → VS Code → 本机 ${local.upstreamOrigin}`;
    statusItem.show();
    return address;
  })();
  try { return await starting; } finally { starting = undefined; }
}

async function stop() {
  if (starting) await starting.catch(() => {});
  const previous = current;
  current = undefined;
  statusItem.text = '$(debug-disconnect) Codex 桥接已停止';
  if (previous) await previous.proxy.stop();
}

async function modelId({ forceChoose = false } = {}) {
  const configured = vscode.workspace.getConfiguration('codexLocalBridge').get('model', '').trim();
  if (configured && !forceChoose) return configured;
  try {
    const catalog = await rpc('models');
    for (const warning of catalog.warnings || []) output.appendLine(`模型发现：${warning}`);
    const models = (catalog.models || []).filter(model => typeof model.id === 'string' && model.id.trim());
    const currentModel = models.find(model => model.id === catalog.currentModel);
    if (!forceChoose && currentModel) return currentModel.id;
    if (!forceChoose && models.length === 1) return models[0].id;
    if (models.length) {
      const sourceNames = { 'local-config': '本机 Codex 配置', 'cc-switch-history': 'CC Switch 当前供应商最近成功的模型', api: 'CC Switch 模型目录' };
      const picks = models.map(model => ({
        label: model.displayName || model.id,
        description: model.id,
        detail: `${sourceNames[model.source] || '模型元数据'}${model.id === catalog.currentModel ? ' · 当前模型' : ''}`,
        id: model.id,
      }));
      picks.push({ label: '手动输入模型 ID…', manual: true });
      const selected = await vscode.window.showQuickPick(picks, {
        title: '选择供应商模型',
        placeHolder: '请求使用右侧的模型 ID，名称用于展示。',
        matchOnDescription: true,
        ignoreFocusOut: true,
      });
      if (!selected) return undefined;
      if (!selected.manual) return selected.id;
    }
  } catch {
    output.appendLine('模型发现暂不可用；请确认本机 Local 扩展已更新，或手动填写模型 ID。');
  }
  return vscode.window.showInputBox({
    title: '本机 CC Switch 已验证可用的模型 ID',
    prompt: '自动发现未提供可用模型时，可填写供应商实际支持的模型 ID。',
    ignoreFocusOut: true,
    validateInput: value => value.trim() ? undefined : '请填写模型 ID。',
  });
}

function providerValues(baseUrl) {
  // 服务器回环代理免认证；本机 CC Switch 统一处理供应商认证。
  const prefix = 'model_providers.vscode_local_bridge_cli';
  return {
    model_provider: 'vscode_local_bridge_cli',
    [`${prefix}.name`]: 'VS Code Local Bridge CLI',
    [`${prefix}.base_url`]: baseUrl,
    [`${prefix}.wire_api`]: 'responses',
    [`${prefix}.requires_openai_auth`]: false,
    [`${prefix}.supports_websockets`]: false,
  };
}

const tomlString = value => JSON.stringify(value);
const shellQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;

async function showConfig(options = {}) {
  const { baseUrl } = await start();
  const model = await modelId(options);
  if (!model) return;
  return showConfigDocument(model, baseUrl);
}

async function showConfigDocument(model, baseUrl) {
  const content = [
    '# 将前两项放到远程用户配置 config.toml 的顶层；已有同名项请替换。',
    '# 配置路径是远程 app-server 使用的 CODEX_HOME/config.toml，默认 ~/.codex/config.toml。',
    '# 服务器无需登录；远程回环代理免认证，本机 CC Switch 统一处理供应商认证。',
    `model = ${tomlString(model.trim())}`,
    'model_provider = "vscode_local_bridge"',
    '',
    '[model_providers.vscode_local_bridge]',
    'name = "VS Code Local Bridge"',
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    '',
    '# 整段使用上述新 provider；不要仅修改原 provider 的 base_url。',
    '# 删除旧桥接 provider 段中的令牌、experimental_bearer_token、env_key、auth 和 Authorization 头设置。',
    '# 保存后，运行 Developer: Reload Window，再新建 Codex 对话验证。',
    '# 旧对话恢复时可能沿用原 provider；重载窗口不会自动切换旧对话。',
    '# 保留你的其他配置；同一 Host 只打开一个启用此桥接的工作区窗口。',
  ].join('\n');
  const document = await vscode.workspace.openTextDocument({ language: 'toml', content });
  await vscode.window.showTextDocument(document, { preview: false });
}

async function configureCodex() {
  const { baseUrl } = await start();
  const model = await modelId();
  if (!model) return;
  const file = resolveConfigPath();
  const snapshot = await readConfig(file);
  let content;
  try { content = buildUpdatedConfig(snapshot.content, model, baseUrl); }
  catch (error) {
    if (error.code !== 'UNSUPPORTED_TOML') throw error;
    const action = await vscode.window.showWarningMessage(error.message, '显示手动配置');
    if (action === '显示手动配置') await showConfigDocument(model, baseUrl);
    return;
  }
  if (content === snapshot.content) {
    await applyConfig(snapshot, content);
    await vscode.window.showInformationMessage('远程 Codex 配置已匹配当前桥接。请运行 Developer: Reload Window，然后在 Codex 侧栏新建对话。');
    return;
  }
  const action = await vscode.window.showInformationMessage('配置远程 Codex', {
    modal: true,
    detail: [
      `远程用户配置：${file}`,
      `模型：${model.trim()}`,
      `Provider：${PROVIDER}`,
      `桥接地址：${baseUrl}`,
      '',
      '将更新顶层 model、model_provider 和此 provider 的连接设置，清理此 provider 中的旧令牌及认证字段，保留其他配置。',
      snapshot.stat ? '先在同目录创建权限为 0600 的原文件备份，再写入配置。备份可能含原配置中的敏感值，请按需保管。' : '将新建远程 CODEX_HOME 目录（0700）和配置文件（0600）。',
      '不写入 API Key 或令牌，不修改 auth.json 或 SSH 设置。',
      '完成后请手动运行 Developer: Reload Window，再新建 Codex 对话。',
      '此路径取自远程扩展宿主的 CODEX_HOME；请确认与远程 Codex 使用的目录一致。',
    ].join('\n'),
  }, '备份并配置');
  if (action !== '备份并配置') return;
  const result = await applyConfig(snapshot, content);
  await vscode.window.showInformationMessage([
    '已配置远程 Codex。请运行 Developer: Reload Window，然后在 Codex 侧栏新建对话。',
    result.backup ? `原配置备份：${result.backup}` : '',
  ].filter(Boolean).join('\n'));
}

async function openTerminal() {
  const { baseUrl } = await start();
  const model = await modelId();
  if (!model) return;
  const values = { ...providerValues(baseUrl), model: model.trim() };
  const args = Object.entries(values).flatMap(([key, value]) => ['-c', `${key}=${typeof value === 'string' ? tomlString(value) : value}`]);
  const noProxy = [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
  const terminal = vscode.window.createTerminal({
    name: 'Codex · 本机 CC Switch',
    env: { NO_PROXY: noProxy, no_proxy: noProxy },
  });
  terminal.show();
  terminal.sendText(['codex', ...args].map(shellQuote).join(' '));
}

async function diagnose({ claude = false } = {}) {
  const { port, baseUrl } = await start();
  const check = path => new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path, agent: false }, response => {
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) { response.destroy(new Error('诊断响应过大。')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.setTimeout(10_000, () => request.destroy(new Error('连接诊断超时。')));
    request.on('error', reject);
  });
  const result = await check('/health');
  output.appendLine(`连接诊断 ${baseUrl}: HTTP ${result.status}`);
  output.show(true);
  if (result.status !== 200) throw new Error(`本机 CC Switch 健康检查返回 HTTP ${result.status}。`);
  const auth = await check('/bridge/auth-check');
  output.appendLine(`服务器回环免认证检查：HTTP ${auth.status}`);
  if (auth.status !== 200) throw new Error(`服务器回环认证模式检查返回 HTTP ${auth.status}。`);
  const authentication = JSON.parse(auth.body);
  if (authentication.authenticated !== true || authentication.authentication !== 'local-cc-switch') {
    throw new Error('服务器回环认证模式返回了非预期响应。');
  }
  if (claude) {
    output.appendLine('Claude 认证：由本机 CC Switch Claude 路由管理供应商 Key；未读取 ChatGPT 或 Claude 订阅登录。');
    vscode.window.showInformationMessage('Claude 健康检查链路已连通。请确认本机 CC Switch 开启 Claude 路由，再在新对话中验证实际模型调用。');
    return;
  }
  const localAuth = await rpc('authStatus');
  output.appendLine(`本机认证：${localAuth.mode === 'local-chatgpt' ? '使用本机 ChatGPT 登录，凭据不传到服务器' : '第三方供应商由 CC Switch 管理 Key'}`);
  vscode.window.showInformationMessage('已验证远程代理 → VS Code → 本机 CC Switch：服务器回环免认证，由本机 CC Switch 处理供应商认证；请确保 Codex 配置选用生成的 provider，并新建 Codex 对话验证。');
}

function activate(context) {
  output = vscode.window.createOutputChannel('Codex Local Bridge');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
  statusItem.command = 'codexLocalBridge.diagnose';
  context.subscriptions.push(output, statusItem);
  context.subscriptions.push(vscode.commands.registerCommand('codexLocalBridge.remote.version', () => ({
    version: context.extension?.packageJSON?.version,
    kind: vscode.env.remoteName && context.extension?.extensionKind === vscode.ExtensionKind?.Workspace ? 'workspace' : 'unavailable',
  })));
  const selectModel = () => showConfig({ forceChoose: true });
  const claudeCommands = createClaudeCommands(vscode, { start });
  const diagnoseClaude = () => diagnose({ claude: true });
  for (const [command, callback] of Object.entries({ start, stop, diagnose, diagnoseClaude, configureCodex, showConfig, selectModel, openTerminal, ...claudeCommands })) {
    context.subscriptions.push(vscode.commands.registerCommand(`codexLocalBridge.${command}`, async () => {
      try { return await callback(); }
      catch (error) {
        const message = error.code === 'EADDRINUSE'
          ? '远程桥接端口已占用，请先关闭同一服务器的其他桥接窗口，或修改 remotePort。'
          : error.message;
        output.appendLine(`操作失败：${message}`);
        vscode.window.showErrorMessage(`Codex Local Bridge：${message}`);
      }
    }));
  }
  if (vscode.env.remoteName && vscode.workspace.getConfiguration('codexLocalBridge').get('autoStart', true)) {
    start().catch(error => output.appendLine(`自动启动未完成：${error.message}。可运行“启动远程桥接”重试。`));
  }
}

async function deactivate() { await stop(); }

module.exports = { activate, deactivate };
