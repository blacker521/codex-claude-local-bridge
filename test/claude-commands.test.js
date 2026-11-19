'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createClaudeCommands, gatewayEnvironment } = require('../remote/src/claude');

function harness({ configured = 'fixture-claude-model', input = 'input-model' } = {}) {
  const state = { starts: 0, prompts: [], documents: [], shown: [], terminals: [] };
  const vscode = {
    workspace: {
      getConfiguration(namespace) {
        assert.equal(namespace, 'codexLocalBridge');
        return { get(key) { assert.equal(key, 'claudeModel'); return configured; } };
      },
      async openTextDocument(document) { state.documents.push(document); return document; },
    },
    window: {
      async showInputBox(options) { state.prompts.push(options); return input; },
      async showTextDocument(document) { state.shown.push(document); },
      createTerminal(options) {
        const terminal = { options, commands: [], show() {}, sendText(value) { this.commands.push(value); } };
        state.terminals.push(terminal);
        return terminal;
      },
    },
  };
  const commands = createClaudeCommands(vscode, {
    start: async () => { state.starts++; return { baseUrl: 'http://127.0.0.1:35721/v1' }; },
    environment: { NO_PROXY: 'existing.example.invalid', no_proxy: 'other.example.invalid' },
  });
  return { ...commands, state };
}

test('Claude 侧栏配置使用origin与非秘密占位认证，不沿用Codex模型或写设置', async () => {
  const h = harness();
  await h.showClaudeConfig();
  assert.equal(h.state.starts, 1);
  assert.equal(h.state.prompts.length, 0);
  const document = h.state.documents[0];
  assert.equal(document.language, 'jsonc');
  const parsed = JSON.parse(document.content.split('\n').filter(line => !line.startsWith('//')).join('\n'));
  assert.equal(parsed['claudeCode.disableLoginPrompt'], true);
  const entries = parsed['claudeCode.environmentVariables'];
  assert.equal(entries.length, new Set(entries.map(item => item.name)).size);
  const env = Object.fromEntries(entries.map(item => [item.name, item.value]));
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:35721');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'PROXY_MANAGED');
  assert.equal(env.ANTHROPIC_API_KEY, '');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, '');
  for (const selector of ['BEDROCK', 'VERTEX', 'FOUNDRY', 'MANTLE', 'ANTHROPIC_AWS', 'ANTHROPIC_GOOGLE_CLOUD']) {
    assert.equal(env[`CLAUDE_CODE_USE_${selector}`], '', '不应继承绕过桥接的云平台选择器');
  }
  for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL']) {
    assert.equal(env[name], 'fixture-claude-model');
  }
  assert.deepEqual(h.state.shown, [document]);
  assert.equal(h.state.terminals.length, 0);
});

test('Claude 模型留空时独立询问；取消不会打开配置或终端', async () => {
  const h = harness({ configured: '' });
  // Supply an explicitly cancelled prompt rather than the harness default.
  const cancelled = createClaudeCommands({
    workspace: { getConfiguration: () => ({ get: () => '' }) },
    window: { showInputBox: async () => undefined },
  }, { start: async () => ({ baseUrl: 'http://127.0.0.1:35721/v1' }), environment: {} });
  await cancelled.showClaudeConfig();
  await cancelled.openClaudeTerminal();
  await h.showClaudeConfig();
  assert.equal(h.state.prompts.length, 1);
  assert.equal(h.state.prompts[0].validateInput(''), '请填写有效模型 ID（最多 200 字符，不含空白或控制字符）。');
  assert.equal(h.state.prompts[0].validateInput('test-model'), undefined);
});

test('Claude 终端以进程设置和模型参数锁定回环路由，保留NO_PROXY列表', async () => {
  const h = harness();
  await h.openClaudeTerminal();
  const terminal = h.state.terminals[0];
  assert.equal(terminal.options.env.ANTHROPIC_AUTH_TOKEN, 'PROXY_MANAGED');
  assert.match(terminal.options.env.NO_PROXY, /^existing\.example\.invalid,other\.example\.invalid,127\.0\.0\.1,localhost,::1$/);
  assert.equal(terminal.options.env.NO_PROXY, terminal.options.env.no_proxy);
  const command = terminal.commands[0];
  const capture = execFileSync('/bin/sh', ['-c', 'claude() { printf "%s\\0" "$@"; }; ' + command], { env: {}, encoding: 'utf8' }).split('\0').slice(0, -1);
  assert.equal(capture[0], '--settings');
  assert.equal(capture[2], '--model');
  assert.equal(capture[3], 'fixture-claude-model');
  assert.deepEqual(JSON.parse(capture[1]).env, terminal.options.env);
  assert.equal(h.state.documents.length, 0);
});

test('Claude 模型中的shell保留字符只能成为字面参数，不能执行命令', async () => {
  const model = 'fixture\'$(printf-injected)`unused`';
  const h = harness({ configured: model });
  await h.openClaudeTerminal();
  const command = h.state.terminals[0].commands[0];
  const capture = execFileSync('/bin/sh', ['-c', 'claude() { printf "%s\\0" "$@"; }; ' + command], { env: {}, encoding: 'utf8' }).split('\0').slice(0, -1);
  assert.equal(capture[3], model);
  assert.equal(JSON.parse(capture[1]).env.ANTHROPIC_MODEL, model);
});

test('Claude配置拒绝不合法模型和非服务器回环地址，不回显输入', () => {
  for (const model of ['', 'two words', 'bad\nmodel', 'x'.repeat(201), null]) {
    assert.throws(() => gatewayEnvironment('http://127.0.0.1:35721/v1', model), /有效.*模型 ID/);
  }
  for (const address of ['https://example.invalid/v1', 'http://user:pass@127.0.0.1:35721/v1', 'http://127.0.0.1:999999/v1', 'http://127.0.0.1:35721/v1?x=1']) {
    assert.throws(() => gatewayEnvironment(address, 'test-model'), error => !error.message.includes(address));
  }
});
