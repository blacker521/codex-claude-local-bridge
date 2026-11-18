'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');

function jsonRoundTrip(value) {
  return JSON.parse(JSON.stringify({ value })).value;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createCommandBus() {
  const handlers = new Map();
  const crossHostCalls = [];
  return {
    handlers,
    crossHostCalls,
    commands(owner) {
      return {
        registerCommand(name, callback) {
          assert.ok(name.startsWith('codexLocalBridge.'), `不应注册其他扩展的命令：${name}`);
          assert.equal(handlers.has(name), false, `重复命令：${name}`);
          handlers.set(name, { owner, callback });
          return { dispose: () => handlers.delete(name) };
        },
        async executeCommand(name, ...args) {
          const target = handlers.get(name);
          assert.ok(target, `未注册命令：${name}`);
          // 不改全局 Module._load；每个虚拟宿主仅通过此 JSON 总线通信。
          const wireArgs = args.map(jsonRoundTrip);
          const call = { name, args: wireArgs };
          if (target.owner !== owner) crossHostCalls.push(call);
          try {
            const result = jsonRoundTrip(await target.callback(...wireArgs));
            if (target.owner !== owner) call.result = result;
            return result;
          } catch (error) {
            const wireError = jsonRoundTrip({ name: error.name, message: error.message, code: error.code });
            throw Object.assign(new Error(wireError.message), wireError);
          }
        },
      };
    },
  };
}

function createHost(owner, bus, settings) {
  const state = {
    infos: [], errors: [], documents: [], shownDocuments: [], terminals: [],
    outputs: [], statusItems: [], configurationReads: [], configurationWrites: [],
    configurationListeners: new Set(), secretAccesses: [],
  };
  const context = {
    subscriptions: [],
    get secrets() {
      state.secretAccesses.push('secrets');
      assert.fail('桥接免认证，不应访问 SecretStorage');
    },
  };
  const vscode = {
    commands: bus.commands(owner),
    env: { remoteName: 'ssh-remote' },
    StatusBarAlignment: { Right: 2 },
    workspace: {
      getConfiguration(namespace) {
        state.configurationReads.push(namespace);
        assert.equal(namespace, 'codexLocalBridge', '桥接不应读取 remote.SSH 或其他扩展的配置');
        return {
          get(key, fallback) {
            return Object.hasOwn(settings, key) ? settings[key] : fallback;
          },
          async update(key, value) {
            state.configurationWrites.push({ namespace, key, value });
            assert.fail('命令应只展示 Codex 配置，不应写入编辑器或 SSH 设置');
          },
        };
      },
      onDidChangeConfiguration(callback) {
        state.configurationListeners.add(callback);
        return { dispose: () => state.configurationListeners.delete(callback) };
      },
      async openTextDocument(options) {
        const document = { ...jsonRoundTrip(options), uri: { scheme: 'untitled' } };
        state.documents.push(document);
        return document;
      },
    },
    window: {
      async showInformationMessage(message) { state.infos.push(message); },
      async showErrorMessage(message) { state.errors.push(message); },
      async showInputBox() { assert.fail('已配置 test-model，不应再次请求模型 ID'); },
      async showTextDocument(document, options) {
        state.shownDocuments.push({ document, options: jsonRoundTrip(options) });
      },
      createOutputChannel(name) {
        const output = {
          name, lines: [], shown: false, disposed: false,
          appendLine(line) { this.lines.push(line); },
          show() { this.shown = true; },
          dispose() { this.disposed = true; },
        };
        state.outputs.push(output);
        return output;
      },
      createStatusBarItem() {
        const status = {
          shown: false, disposed: false,
          show() { this.shown = true; },
          hide() { this.shown = false; },
          dispose() { this.disposed = true; },
        };
        state.statusItems.push(status);
        return status;
      },
      createTerminal(options) {
        const terminal = {
          options: jsonRoundTrip(options), commands: [], shown: false,
          show() { this.shown = true; },
          sendText(command) { this.commands.push(command); },
        };
        state.terminals.push(terminal);
        return terminal;
      },
    },
  };
  return { vscode, context, state };
}

function loadIsolatedExtension(relativePath, vscode, requireOverrides = {}) {
  const filename = path.resolve(__dirname, '..', relativePath);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const sandbox = vm.createContext({
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    // 只提供测试进程环境，避免读取用户的真实环境变量。
    process: { env: { NO_PROXY: 'existing.internal', no_proxy: 'old.internal' } },
  });
  const load = new vm.Script(wrap(fs.readFileSync(filename, 'utf8')), { filename }).runInContext(sandbox);
  const isolatedRequire = (id) => {
    if (id === 'vscode') return vscode;
    if (Object.hasOwn(requireOverrides, id)) return requireOverrides[id];
    if (id === './local-auth') {
      // 扩展集成只使用 fixture 认证结果，禁止模块读取真实用户的 auth.json。
      return {
        async resolveLocalAuthentication({ mode }) {
          assert.equal(mode, 'proxy-managed', '扩展集成测试必须显式使用托管认证');
          return { mode, headers: { authorization: 'Bearer PROXY_MANAGED' } };
        },
      };
    }
    return realRequire(id);
  };
  load(module.exports, isolatedRequire, module, filename, path.dirname(filename));
  return module.exports;
}

async function disposeContext(context) {
  for (const subscription of context.subscriptions.splice(0).reverse()) {
    await subscription.dispose();
  }
}

function openStream(port) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/v1/responses', method: 'POST', agent: false,
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      response.on('error', () => {});
      response.once('data', () => resolve({ request, response }));
    });
    request.once('error', reject);
    request.end('{"model":"test-model","stream":true,"input":"生命周期测试"}');
  });
}

async function assertPortClosed(port) {
  const result = await within(new Promise((resolve) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/health', agent: false });
    request.once('response', (response) => {
      response.resume();
      resolve('still-listening');
    });
    request.once('error', (error) => resolve(error.code));
  }), '停止后检查监听端口超时');
  assert.equal(result, 'ECONNREFUSED');
}

test('双端扩展通过 JSON 命令总线激活、诊断和生成官方 Codex 配置，且独立于 SSH 设置', { timeout: 15000 }, async (t) => {
  const requests = [];
  const sockets = new Set();
  const upstreamStreams = [];
  const upstream = http.createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    request.resume();
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ok"}');
      return;
    }
    assert.equal(request.url, '/v1/responses');
    const closed = deferred();
    upstreamStreams.push(closed);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"status":"started"}\n\n');
    const timer = setInterval(() => response.write(': keepalive\n\n'), 20);
    response.once('close', () => { clearInterval(timer); closed.resolve(); });
  });
  upstream.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const bus = createCommandBus();
  const local = createHost('local', bus, {
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, authentication: 'proxy-managed',
  });
  const remote = createHost('remote', bus, { remotePort: 0, autoStart: false, model: 'test-model' });
  const localExtension = loadIsolatedExtension('local/src/extension.js', local.vscode);
  const remoteExtension = loadIsolatedExtension('remote/src/extension.js', remote.vscode);
  t.after(async () => {
    // 测试中途失败时也取消本机会话，再停止远程代理，避免长流阻塞清理。
    await disposeContext(local.context);
    await remoteExtension.deactivate();
    await disposeContext(remote.context);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  });
  await localExtension.activate(local.context);
  await remoteExtension.activate(remote.context);
  const execute = (...args) => remote.vscode.commands.executeCommand(...args);
  assert.equal(requests.length, 0, 'autoStart=false 时激活不应访问上游');
  assert.equal(bus.crossHostCalls.length, 0);
  assert.deepEqual(remote.state.secretAccesses, []);

  const address = await execute('codexLocalBridge.start');
  assert.ok(address.port > 0);
  assert.equal(address.baseUrl, `http://127.0.0.1:${address.port}/v1`);
  assert.deepEqual(remote.state.secretAccesses, [], '启动不应访问 SecretStorage');
  assert.deepEqual(local.state.secretAccesses, []);
  assert.deepEqual(await execute('codexLocalBridge.start'), address, '重复启动应复用当前监听地址');

  await execute('codexLocalBridge.diagnose');
  assert.deepEqual(requests, [{ path: '/health', authorization: 'Bearer PROXY_MANAGED' }]);
  const authenticationChecks = bus.crossHostCalls.filter(({ name }) => name === 'codexLocalBridge.local.authStatus');
  assert.equal(authenticationChecks.length, 1);
  assert.deepEqual(authenticationChecks[0].result, { mode: 'proxy-managed' },
    '认证诊断只能向服务器返回模式，不得返回 headers 或 tokens');
  assert.ok(remote.state.infos.some((message) => message.includes('已验证远程代理')));
  assert.ok(remote.state.outputs[0].lines.some((line) => line.includes('HTTP 200')));
  assert.equal(remote.state.outputs[0].shown, true);

  await execute('codexLocalBridge.showConfig');
  assert.equal(remote.state.documents.length, 1);
  const document = remote.state.documents[0];
  assert.equal(document.language, 'toml');
  assert.ok(document.content.includes(`base_url = ${JSON.stringify(address.baseUrl)}`));
  assert.doesNotMatch(document.content, /^\s*(?:experimental_bearer_token|env_key|auth|http_headers|env_http_headers)\s*=/m,
    '配置不应包含令牌、认证环境变量或认证头');
  assert.match(document.content, /model = "test-model"/);
  assert.match(document.content, /远程用户配置 config\.toml 的顶层/);
  assert.match(document.content, /CODEX_HOME\/config\.toml/);
  assert.ok(document.content.includes('~/.codex/config.toml'));
  assert.match(document.content, /supports_websockets = false/);
  assert.match(document.content, /requires_openai_auth = false/);
  assert.match(document.content, /Developer: Reload Window/);
  assert.ok(document.content.indexOf('model = ') < document.content.indexOf('[model_providers.'));
  assert.equal(remote.state.shownDocuments[0].document, document);
  assert.equal(remote.state.shownDocuments[0].options.preview, false);

  await execute('codexLocalBridge.openTerminal');
  assert.equal(remote.state.terminals.length, 1);
  const terminal = remote.state.terminals[0];
  assert.deepEqual(Object.keys(terminal.options.env).sort(), ['NO_PROXY', 'no_proxy']);
  assert.equal(terminal.shown, true);
  for (const key of ['NO_PROXY', 'no_proxy']) {
    for (const host of ['existing.internal', 'old.internal', '127.0.0.1', 'localhost', '::1']) {
      assert.ok(terminal.options.env[key].split(',').includes(host));
    }
  }
  assert.equal(terminal.commands.length, 1);
  assert.doesNotMatch(terminal.commands[0], /CODEX_LOCAL_BRIDGE_KEY|env_key|experimental_bearer_token|Authorization/i,
    'CLI 不应设置桥接令牌或认证环境变量');
  assert.ok(terminal.commands[0].includes(address.baseUrl));
  assert.ok(terminal.commands[0].includes('requires_openai_auth=false'));
  assert.ok(terminal.commands[0].includes('test-model'));

  const status = () => execute('codexLocalBridge.local.status');
  assert.equal((await status()).activeRequests, 0);
  const firstStream = await within(openStream(address.port), 'stop 测试流首块未到达');
  const firstClosed = new Promise((resolve) => firstStream.response.once('close', resolve));
  assert.equal((await status()).activeRequests, 1);
  await within(execute('codexLocalBridge.stop'), 'stop 命令未完成');
  await within(Promise.all([firstClosed, upstreamStreams[0].promise]), 'stop 未释放上下游长流');
  assert.equal((await status()).activeRequests, 0);
  await assertPortClosed(address.port);
  await execute('codexLocalBridge.stop');

  const restarted = await execute('codexLocalBridge.start');
  assert.deepEqual(remote.state.secretAccesses, [], '重新启动仍不应访问 SecretStorage');
  const secondStream = await within(openStream(restarted.port), 'deactivate 测试流首块未到达');
  const secondClosed = new Promise((resolve) => secondStream.response.once('close', resolve));
  assert.equal((await status()).activeRequests, 1);
  await within(remoteExtension.deactivate(), '远程 deactivate 未完成');
  await within(Promise.all([secondClosed, upstreamStreams[1].promise]), 'deactivate 未释放上下游长流');
  assert.equal((await status()).activeRequests, 0);
  await assertPortClosed(restarted.port);

  assert.ok(bus.crossHostCalls.some(({ name }) => name === 'codexLocalBridge.local.read'));
  assert.ok(bus.crossHostCalls.filter(({ name }) => name === 'codexLocalBridge.local.cancel').length >= 3);
  assert.equal(bus.crossHostCalls.some(({ name }) => name === 'codexLocalBridge.local.models'), false,
    '显式配置了模型 ID 时不应执行自动发现');
  assert.deepEqual(requests.slice(1), [
    { path: '/v1/responses', authorization: 'Bearer PROXY_MANAGED' },
    { path: '/v1/responses', authorization: 'Bearer PROXY_MANAGED' },
  ], '无服务器令牌的请求仍由本机端管理上游认证');
  for (const { args } of bus.crossHostCalls.filter(({ name }) => name === 'codexLocalBridge.local.begin')) {
    assert.equal(Object.hasOwn(args[0].headers, 'authorization'), false);
    assert.equal(Object.hasOwn(args[0].headers, 'chatgpt-account-id'), false);
  }
  assert.deepEqual(local.state.secretAccesses, []);
  assert.deepEqual(remote.state.secretAccesses, []);
  assert.deepEqual(local.state.errors, []);
  assert.deepEqual(remote.state.errors, []);
  assert.deepEqual(local.state.configurationWrites, []);
  assert.deepEqual(remote.state.configurationWrites, []);
  assert.ok([...local.state.configurationReads, ...remote.state.configurationReads].every((name) => name === 'codexLocalBridge'));
  await disposeContext(remote.context);
  await disposeContext(local.context);
  assert.equal(bus.handlers.size, 0);
  assert.equal(local.state.configurationListeners.size, 0);
  assert.equal(remote.state.outputs[0].disposed, true);
  assert.equal(remote.state.statusItems[0].disposed, true);
});

async function createModelSelectionHarness(t, {
  configuredModel = '', catalog, catalogError, pick, input, requireOverrides,
} = {}) {
  const bus = createCommandBus();
  const localCommands = bus.commands('local');
  let discoveryCalls = 0;
  // 只模拟跨宿主的两个 DTO 命令，不激活本机模型发现模块，避免读取真实用户配置。
  const registrations = [
    localCommands.registerCommand('codexLocalBridge.local.status', () => ({
      protocolVersion: 1, upstreamOrigin: 'http://127.0.0.1:9', activeRequests: 0,
    })),
    localCommands.registerCommand('codexLocalBridge.local.models', () => {
      discoveryCalls++;
      if (catalogError) throw new Error(catalogError);
      return catalog;
    }),
  ];
  const remote = createHost('remote', bus, {
    remotePort: 0, autoStart: false, model: configuredModel,
  });
  const quickPicks = [];
  const inputBoxes = [];
  const warnings = [];
  remote.vscode.window.showWarningMessage = async (message) => { warnings.push(message); };
  remote.vscode.window.showQuickPick = async (items, options) => {
    const candidates = await items;
    quickPicks.push({ items: jsonRoundTrip(candidates), options: jsonRoundTrip(options) });
    assert.equal(typeof pick, 'function', '此场景不应要求选择模型');
    return pick(candidates, options);
  };
  remote.vscode.window.showInputBox = async (options) => {
    inputBoxes.push(options);
    assert.equal(typeof input, 'function', '此场景不应要求手动输入模型 ID');
    return input(options);
  };
  const extension = loadIsolatedExtension('remote/src/extension.js', remote.vscode, requireOverrides);
  t.after(async () => {
    await extension.deactivate();
    await disposeContext(remote.context);
    registrations.forEach((registration) => registration.dispose());
    assert.deepEqual(remote.state.configurationWrites, [], '选择模型不应写入用户设置');
    assert.deepEqual(remote.state.secretAccesses, [], '模型发现和配置生成不应访问 SecretStorage');
    assert.ok(remote.state.configurationReads.every((namespace) => namespace === 'codexLocalBridge'));
  });
  await extension.activate(remote.context);
  return {
    ...remote,
    bus, quickPicks, inputBoxes, warnings,
    get discoveryCalls() { return discoveryCalls; },
    async showConfig(command = 'showConfig') {
      await remote.vscode.commands.executeCommand(`codexLocalBridge.${command}`);
      return remote.state.documents.at(-1)?.content;
    },
  };
}

function modelInConfig(content) {
  assert.equal(typeof content, 'string', '应生成配置片段');
  const match = content.match(/^model = (.+)$/m);
  assert.ok(match, '配置片段应包含顶层 model');
  return JSON.parse(match[1]);
}

test('空模型配置自动采用目录中的 currentModel，使用真实 ID 而非展示名', async (t) => {
  const current = { id: 'provider/current-coder:v2', displayName: '当前代码模型', source: 'local-config' };
  const harness = await createModelSelectionHarness(t, {
    catalog: {
      models: [
        { id: 'provider/other', displayName: '其他模型', source: 'api' },
        current,
      ],
      currentModel: current.id,
      warnings: [],
    },
  });
  assert.equal(modelInConfig(await harness.showConfig()), current.id);
  assert.equal(harness.discoveryCalls, 1);
  assert.equal(harness.quickPicks.length, 0);
  assert.equal(harness.inputBoxes.length, 0);
  assert.deepEqual(harness.state.errors, []);
});

test('仅一个候选时自动采用该 ID，忽略已不在目录中的 currentModel', async (t) => {
  const candidate = { id: 'provider/only-model', displayName: '唯一模型展示名', source: 'api' };
  const harness = await createModelSelectionHarness(t, {
    catalog: { models: [candidate], currentModel: 'retired/model', warnings: [] },
  });
  assert.equal(modelInConfig(await harness.showConfig()), candidate.id);
  assert.equal(harness.discoveryCalls, 1);
  assert.equal(harness.quickPicks.length, 0);
  assert.equal(harness.inputBoxes.length, 0);
  assert.deepEqual(harness.state.errors, []);
});

test('多个候选展示名称、真实 ID 和来源，选择结果写入真实 ID', async (t) => {
  const api = { id: 'provider/api-coder', displayName: '接口代码模型', source: 'api' };
  const local = { id: 'provider/local-coder', displayName: '本机代码模型', source: 'local-config' };
  const harness = await createModelSelectionHarness(t, {
    catalog: { models: [api, local], currentModel: null, warnings: [] },
    pick(items) {
      const apiItem = items.find((item) => item.description === api.id);
      const localItem = items.find((item) => item.description === local.id);
      assert.ok(apiItem);
      assert.ok(localItem);
      assert.equal(apiItem.label, api.displayName);
      assert.equal(localItem.label, local.displayName);
      assert.equal(typeof apiItem.detail, 'string');
      assert.equal(typeof localItem.detail, 'string');
      assert.ok(apiItem.detail.length > 0 && localItem.detail.length > 0);
      assert.notEqual(apiItem.detail, localItem.detail, '不同来源应能在选择器中区分');
      assert.ok(items.some((item) => item.label.includes('手动')), '应保留手动输入选项');
      return localItem;
    },
  });
  assert.equal(modelInConfig(await harness.showConfig()), local.id);
  assert.equal(harness.quickPicks.length, 1);
  assert.equal(harness.inputBoxes.length, 0);
  assert.equal(harness.discoveryCalls, 1);
  assert.deepEqual(harness.state.errors, []);
});

test('selectModel 即使已有显式模型和有效 currentModel，也强制选择并生成配置', async (t) => {
  const current = { id: 'provider/current', displayName: '当前模型', source: 'local-config' };
  const chosen = { id: 'provider/chosen', displayName: '新选择的展示名', source: 'api' };
  const harness = await createModelSelectionHarness(t, {
    configuredModel: 'explicit/previous',
    catalog: { models: [current, chosen], currentModel: current.id, warnings: [] },
    pick: (items) => items.find((item) => item.description === chosen.id),
  });
  assert.equal(modelInConfig(await harness.showConfig('selectModel')), chosen.id);
  assert.equal(harness.discoveryCalls, 1);
  assert.equal(harness.quickPicks.length, 1);
  assert.equal(harness.inputBoxes.length, 0);
  assert.deepEqual(harness.state.errors, []);
});

test('多候选中的手动选项回退 InputBox，并保留手工模型 ID', async (t) => {
  const harness = await createModelSelectionHarness(t, {
    catalog: {
      models: [
        { id: 'catalog/a', displayName: '模型 A', source: 'api' },
        { id: 'catalog/b', displayName: '模型 B', source: 'api' },
      ],
      currentModel: null, warnings: [],
    },
    pick: (items) => items.find((item) => item.label.includes('手动')),
    input: () => '  manual/model:latest  ',
  });
  assert.equal(modelInConfig(await harness.showConfig()), 'manual/model:latest');
  assert.equal(harness.quickPicks.length, 1);
  assert.equal(harness.inputBoxes.length, 1);
  assert.deepEqual(harness.state.errors, []);
});

for (const scenario of [
  { name: '目录为空', catalog: { models: [], currentModel: null, warnings: [] } },
  { name: '目录 RPC 失败', catalogError: '模型目录暂不可用' },
]) {
  test(`${scenario.name}时回退手动输入，仍能生成有效配置`, async (t) => {
    const harness = await createModelSelectionHarness(t, {
      ...scenario,
      input: () => 'manual/fallback-model',
    });
    assert.equal(modelInConfig(await harness.showConfig()), 'manual/fallback-model');
    assert.equal(harness.discoveryCalls, 1);
    assert.equal(harness.quickPicks.length, 0);
    assert.equal(harness.inputBoxes.length, 1);
  });
}

test('取消模型选择时不生成配置，也不跳转手动输入', async (t) => {
  const harness = await createModelSelectionHarness(t, {
    catalog: {
      models: [
        { id: 'catalog/a', displayName: '模型 A', source: 'api' },
        { id: 'catalog/b', displayName: '模型 B', source: 'api' },
      ],
      currentModel: null, warnings: [],
    },
    pick: () => undefined,
  });
  assert.equal(await harness.showConfig(), undefined);
  assert.equal(harness.state.documents.length, 0);
  assert.equal(harness.quickPicks.length, 1);
  assert.equal(harness.inputBoxes.length, 0);
  assert.deepEqual(harness.state.errors, []);
});

async function createConfigureHarness(t, { content, approve, catalog } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-command-test-'));
  const file = path.join(directory, 'remote-codex-home', 'config.toml');
  if (content !== undefined) {
    fs.mkdirSync(path.dirname(file), { mode: 0o700 });
    fs.writeFileSync(file, content, { mode: 0o600 });
  }
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configure = require('../remote/src/configure');
  const harness = await createModelSelectionHarness(t, {
    configuredModel: catalog ? '' : 'configured/model', catalog,
    requireOverrides: { './configure': { ...configure, resolveConfigPath: () => file } },
  });
  const confirmations = [];
  harness.vscode.window.showInformationMessage = async (message, options, ...items) => {
    harness.state.infos.push(message);
    if (options?.modal) {
      confirmations.push({ message, options: jsonRoundTrip(options), items });
      assert.equal(fs.existsSync(path.join(path.dirname(file), '.codex-local-bridge-config.lock')), false,
        '明确确认前不得写入配置、备份或锁文件');
      if (approve) return approve(file, options);
    }
    return undefined;
  };
  return { ...harness, file, confirmations, configure: () => harness.vscode.commands.executeCommand('codexLocalBridge.configureCodex') };
}

test('配置远程 Codex 先列出路径、发现的真实模型和 provider；确认后备份写入并提示手动重载', async t => {
  const original = 'model="old"\nmodel_provider="old-provider"\n[model_providers.vscode_local_bridge]\nexperimental_bearer_token="FAKE_OLD_TOKEN"\n';
  const harness = await createConfigureHarness(t, {
    content: original,
    catalog: {
      currentModel: 'discovered/provider-model',
      models: [{ id: 'discovered/provider-model', displayName: '展示名称', source: 'api' }], warnings: [],
    },
    approve(file) {
      assert.equal(fs.readFileSync(file, 'utf8'), original);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.toml']);
      return '备份并配置';
    },
  });
  await harness.configure();
  assert.equal(harness.confirmations.length, 1);
  const [{ options, items }] = harness.confirmations;
  assert.ok(options.detail.includes(harness.file));
  assert.ok(options.detail.includes('discovered/provider-model'));
  assert.ok(options.detail.includes('vscode_local_bridge'));
  assert.ok(options.detail.includes('model_provider'));
  assert.ok(options.detail.includes('0600'));
  assert.deepEqual(items, ['备份并配置']);
  const updated = fs.readFileSync(harness.file, 'utf8');
  assert.match(updated, /^model="discovered\/provider-model"$/m);
  assert.match(updated, /^model_provider="vscode_local_bridge"$/m);
  assert.doesNotMatch(updated, /FAKE_OLD_TOKEN|experimental_bearer_token/);
  const backups = fs.readdirSync(path.dirname(harness.file)).filter(name => name.includes('bridge-backup'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(harness.file), backups[0]), 'utf8'), original);
  assert.ok(harness.state.infos.some(message => message.includes('Developer: Reload Window') && message.includes('新建对话')));
  assert.equal(harness.state.documents.length, 0);
  assert.deepEqual(harness.state.errors, []);
  assert.equal(harness.bus.crossHostCalls.some(call => call.name.includes('auth')), false);
});

test('取消明确确认后原配置不变，也不产生备份和新目录', async t => {
  for (const content of [undefined, 'model="old"\n']) {
    const harness = await createConfigureHarness(t, { content });
    await harness.configure();
    assert.equal(harness.confirmations.length, 1);
    if (content === undefined) assert.equal(fs.existsSync(path.dirname(harness.file)), false);
    else {
      assert.equal(fs.readFileSync(harness.file, 'utf8'), content);
      assert.deepEqual(fs.readdirSync(path.dirname(harness.file)), ['config.toml']);
    }
    assert.deepEqual(harness.state.errors, []);
  }
});

test('确认期间发生外部编辑时命令报告冲突，保留外部更改', async t => {
  const external = 'model="external-update"\n';
  const harness = await createConfigureHarness(t, {
    content: 'model="old"\n',
    approve(file) { fs.writeFileSync(file, external); return '备份并配置'; },
  });
  await harness.configure();
  assert.equal(fs.readFileSync(harness.file, 'utf8'), external);
  assert.equal(harness.state.errors.length, 1);
  assert.match(harness.state.errors[0], /已被其他操作修改/);
});

test('无法安全更新复杂 TOML 时保持原文件，可打开已有手动配置流程', async t => {
  const original = 'instructions = """\nfixture multiline\n"""\n';
  const harness = await createConfigureHarness(t, { content: original });
  harness.vscode.window.showWarningMessage = async message => {
    harness.warnings.push(message);
    return '显示手动配置';
  };
  await harness.configure();
  assert.equal(harness.confirmations.length, 0);
  assert.equal(fs.readFileSync(harness.file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(path.dirname(harness.file)), ['config.toml']);
  assert.match(harness.warnings[0], /未写入文件/);
  assert.equal(modelInConfig(harness.state.documents.at(-1).content), 'configured/model');
  assert.deepEqual(harness.state.errors, []);
});

test('新建配置只使用远程用户路径，重复执行不再弹确认或重复备份', async t => {
  const harness = await createConfigureHarness(t, { approve: () => '备份并配置' });
  await harness.configure();
  assert.equal(harness.confirmations.length, 1);
  assert.equal(fs.statSync(harness.file).mode & 0o777, 0o600);
  const original = fs.readFileSync(harness.file, 'utf8');
  await harness.configure();
  assert.equal(harness.confirmations.length, 1);
  assert.equal(fs.readFileSync(harness.file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(path.dirname(harness.file)), ['config.toml']);
  assert.ok(harness.state.infos.some(message => message.includes('已匹配当前桥接')));
  assert.deepEqual(harness.state.errors, []);
});
