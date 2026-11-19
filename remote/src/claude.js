'use strict';

const validModel = value => typeof value === 'string' && value.trim().length > 0 &&
  value.trim().length <= 200 && !/[\s\x00-\x1f\x7f-\x9f]/u.test(value.trim());

function gatewayEnvironment(baseUrl, model) {
  if (!validModel(model)) throw new Error('请填写有效的 Claude 模型 ID（最多 200 字符，不含空白或控制字符）。');
  if (typeof baseUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(baseUrl)) {
    throw new Error('Claude 桥接地址必须是服务器回环地址。');
  }
  let origin;
  try { origin = new URL(baseUrl).origin; }
  catch { throw new Error('Claude 桥接地址无效。'); }
  return {
    ANTHROPIC_BASE_URL: origin,
    // A non-secret placeholder enables Claude's gateway mode. The remote
    // proxy strips it; only CC Switch supplies the real provider credential.
    ANTHROPIC_AUTH_TOKEN: 'PROXY_MANAGED',
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_USE_BEDROCK: '',
    CLAUDE_CODE_USE_VERTEX: '',
    CLAUDE_CODE_USE_FOUNDRY: '',
    CLAUDE_CODE_USE_MANTLE: '',
    CLAUDE_CODE_USE_ANTHROPIC_AWS: '',
    CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '',
    ANTHROPIC_MODEL: model.trim(),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model.trim(),
    ANTHROPIC_DEFAULT_SONNET_MODEL: model.trim(),
    ANTHROPIC_DEFAULT_OPUS_MODEL: model.trim(),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  };
}

const shellQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;

function createClaudeCommands(vscode, { start, environment = process.env }) {
  async function options() {
    const address = await start();
    const configured = vscode.workspace.getConfiguration('codexLocalBridge').get('claudeModel', '');
    const model = typeof configured === 'string' && configured.trim() ? configured : await vscode.window.showInputBox({
      title: 'CC Switch Claude 路由支持的模型 ID',
      prompt: '填写 Claude 路由实际支持的模型 ID；不会沿用 Codex 模型或推测展示名。',
      ignoreFocusOut: true,
      validateInput: value => validModel(value) ? undefined : '请填写有效模型 ID（最多 200 字符，不含空白或控制字符）。',
    });
    if (model === undefined) return undefined;
    return gatewayEnvironment(address.baseUrl, model);
  }

  async function showClaudeConfig() {
    const env = await options();
    if (!env) return;
    const content = [
      '// 合入当前服务器的 VS Code / Cursor 远程用户设置 JSON，不要覆盖其他设置。',
      '// 若已有 claudeCode.environmentVariables，请按 name 更新下列条目，保留无关条目。',
      '// PROXY_MANAGED 是公开占位值，不是实际 API Key；真实认证留在本机 CC Switch。',
      '// 本机 CC Switch 需开启 Claude 路由；不读取或转发本机 Claude 订阅登录。',
      '// 检查远程 ~/.claude/settings.json、项目和组织设置，处理覆盖此片段的同名 env。',
      '// 组织策略优先级更高，本插件不修改或绕过它；最终用 /status 确认路由。',
      '// 如已有 NO_PROXY/no_proxy 条目，请保留自己的列表并加入三个回环地址。',
      '// 三个模型档位暂指向所选模型，可按供应商支持情况分别修改。',
      '// 保存后重载窗口，在官方 Claude Code 侧栏新建对话，用 /status 核对地址。',
      JSON.stringify({
        'claudeCode.disableLoginPrompt': true,
        'claudeCode.environmentVariables': Object.entries(env).map(([name, value]) => ({ name, value })),
      }, null, 2),
    ].join('\n');
    const document = await vscode.workspace.openTextDocument({ language: 'jsonc', content });
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async function openClaudeTerminal() {
    const env = await options();
    if (!env) return;
    const noProxy = [environment.NO_PROXY, environment.no_proxy, env.NO_PROXY].filter(Boolean).join(',');
    const sessionEnv = { ...env, NO_PROXY: noProxy, no_proxy: noProxy };
    const terminal = vscode.window.createTerminal({ name: 'Claude Code · 本机 CC Switch', env: sessionEnv });
    terminal.show();
    // --settings overrides ordinary saved settings for this invocation, so a
    // stale user env block cannot restore an unrelated endpoint or credential.
    terminal.sendText(['claude', '--settings', JSON.stringify({ env: sessionEnv }), '--model', env.ANTHROPIC_MODEL].map(shellQuote).join(' '));
  }

  return { showClaudeConfig, openClaudeTerminal };
}

module.exports = { createClaudeCommands, gatewayEnvironment };
