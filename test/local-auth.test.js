'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { inspect } = require('node:util');
const { createRequire, wrap } = require('node:module');
const { resolveLocalAuthentication } = require('../local/src/local-auth');
const { LocalBroker, isClaudePath } = require('../local/src/broker');
const { RemoteProxy } = require('../remote/src/proxy');

const MAX_AUTH_BYTES = 1024 * 1024;
const ACCESS_TOKEN = 'genuine-fixture-only-local-chatgpt-token';
const ACCOUNT_ID = 'fixture-only-local-account';
const OTHER_SECRET = 'fixture-only-refresh-id-and-api-key-secret';
const SERVER_TOKEN = 'fixture-only-server-login-token';
const MANAGED = { mode: 'proxy-managed', headers: { authorization: 'Bearer PROXY_MANAGED' } };

function localLogin(accessToken = ACCESS_TOKEN, accountId = ACCOUNT_ID) {
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: OTHER_SECRET,
    tokens: {
      access_token: accessToken,
      account_id: accountId,
      refresh_token: OTHER_SECRET,
      id_token: OTHER_SECRET,
    },
    // 本桥仅使用本机当前快照，不检查到期时间，也不代替原生账号刷新。
    expires_at: '2000-01-01T00:00:00Z',
    last_refresh: '2000-01-01T00:00:00Z',
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-local-auth-test-'));
  const homeDirectory = path.join(root, 'home');
  await fs.mkdir(homeDirectory);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    homeDirectory,
    codexHome: path.join(homeDirectory, '.codex'),
    // 所有解析调用都覆盖真实环境和主目录，不访问使用者的 auth 或 config。
    options: { env: {}, homeDirectory },
    async writeAuth(login, directory = path.join(homeDirectory, '.codex')) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'auth.json'), typeof login === 'string' ? login : JSON.stringify(login));
      return directory;
    },
  };
}

function assertSafe(value, forbidden = [ACCESS_TOKEN, ACCOUNT_ID, OTHER_SECRET]) {
  const serialized = inspect(value, { depth: 8 });
  for (const secret of forbidden) {
    assert.equal(serialized.includes(secret), false, 'RPC 结果和错误不得包含本机凭据或文件正文');
  }
}

async function assertSafeRejection(operation, forbidden) {
  await assert.rejects(operation, (error) => {
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0 && error.message.length <= 300, '应返回简短的安全提示');
    assertSafe(error, forbidden);
    return true;
  });
}

function loadWithFileSystem(fileSystem) {
  const filename = path.resolve(__dirname, '../local/src/local-auth.js');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  return fs.readFile(filename, 'utf8').then((source) => {
    const load = vm.runInNewContext(wrap(source), {
      Buffer, URL, process: { env: {} }, setTimeout, clearTimeout,
    }, { filename });
    load(module.exports, (id) => {
      if (['node:fs/promises', 'fs/promises'].includes(id)) return fileSystem;
      if (['node:fs', 'fs'].includes(id)) return { promises: fileSystem };
      return realRequire(id);
    }, module, filename, path.dirname(filename));
    return module.exports.resolveLocalAuthentication;
  });
}

function jsonRoundTrip(value) {
  return JSON.parse(JSON.stringify(value));
}

async function mockUpstream(t, handler = (_request, response) => response.end('fixture-response')) {
  const requests = [];
  const sockets = new Set();
  const errors = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, headers: { ...request.headers } });
    request.resume();
    Promise.resolve().then(() => handler(request, response)).catch((error) => {
      errors.push(error);
      response.destroy();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(errors, [], '模拟上游不得出现内部错误');
  });
  return { upstreamOrigin: `http://127.0.0.1:${server.address().port}`, requests };
}

async function rpcHarness(t, options, handler) {
  const upstream = await mockUpstream(t, handler);
  const handlers = new Map();
  const subscriptions = [];
  const settings = {
    upstreamOrigin: upstream.upstreamOrigin,
    codexHome: options.codexHome || '',
    authentication: options.mode || 'auto',
  };
  let broker;
  const filename = path.resolve(__dirname, '../local/src/extension.js');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const vscode = {
    commands: {
      registerCommand(name, callback) {
        handlers.set(name, callback);
        return { dispose: () => handlers.delete(name) };
      },
    },
    workspace: {
      getConfiguration(namespace) {
        assert.equal(namespace, 'codexLocalBridge', '不能读取 SSH 或其他扩展配置');
        return { get: (key, fallback) => Object.hasOwn(settings, key) ? settings[key] : fallback };
      },
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    window: {
      showErrorMessage(message) { assert.fail(message); },
      showInformationMessage() {},
    },
  };
  const load = vm.runInNewContext(wrap(await fs.readFile(filename, 'utf8')), {
    Buffer, URL, process: { env: {} }, setTimeout, clearTimeout,
  }, { filename });
  load(module.exports, (id) => {
    if (id === 'vscode') return vscode;
    if (id === './broker') return {
      isClaudePath,
      LocalBroker: class extends LocalBroker {
        constructor(configuration) { super({ ...configuration, idleTimeoutMs: 5000 }); broker = this; }
      },
    };
    if (id === './local-auth') return {
      // 运行真实解析器；只固定临时目录和隔离环境，绝不触及真实账号。
      resolveLocalAuthentication: argument => resolveLocalAuthentication({ ...argument, ...options }),
    };
    if (id === './model-discovery') return { discoverModels() { assert.fail('鉴权测试不读取模型配置'); } };
    return realRequire(id);
  }, module, filename, path.dirname(filename));
  module.exports.activate({ subscriptions });
  const calls = [];
  const rpc = async (method, argument) => {
    const wire = jsonRoundTrip({ method, argument });
    calls.push(wire);
    // 调用真实本机命令包装，凭据仅在 JSON 已跨宿主以后注入。
    // 远程额外传第二参数也不能成为 broker 的可信头。
    const extra = method === 'begin' ? { authorization: `Bearer ${SERVER_TOKEN}` } : undefined;
    const result = await handlers.get(`codexLocalBridge.local.${method}`)(wire.argument, extra);
    wire.result = jsonRoundTrip(result);
    return wire.result;
  };
  const proxy = new RemoteProxy({ rpc, port: 0 });
  t.after(async () => {
    await proxy.stop();
    for (const subscription of subscriptions.reverse()) await subscription.dispose();
  });
  const address = await proxy.start();
  return { ...upstream, broker, calls, rpc, port: address.port };
}

function exchange(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/responses', agent: false,
      headers: {
        authorization: `Bearer ${SERVER_TOKEN}`,
        'chatgpt-account-id': 'fixture-server-account',
        'content-type': 'application/json',
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end('{"model":"fixture-model","input":"fixture-input"}');
  });
}

async function drain(broker, opened) {
  const ended = await broker.end(opened);
  const reads = [];
  for (;;) {
    const part = await broker.read({ ...opened, waitMs: 1000 });
    reads.push(part);
    if (part.done) break;
  }
  const cancelled = broker.cancel(opened);
  return { opened, ended, reads, cancelled, status: broker.status() };
}

test('官方本机 ChatGPT 快照只导出当前 access_token 和 account_id，不刷新或改写文件', async (t) => {
  const files = await fixture(t);
  await files.writeAuth(localLogin());
  const filename = path.join(files.codexHome, 'auth.json');
  const before = await fs.readFile(filename);
  const expected = {
    mode: 'local-chatgpt',
    headers: { authorization: `Bearer ${ACCESS_TOKEN}`, 'chatgpt-account-id': ACCOUNT_ID },
  };
  assert.deepEqual(await resolveLocalAuthentication(files.options), expected);
  assert.deepEqual(await resolveLocalAuthentication({ ...files.options, mode: 'local-chatgpt' }), expected);
  assert.deepEqual(await fs.readFile(filename), before);
  assert.deepEqual(await fs.readdir(files.codexHome), ['auth.json']);
});

test('缺省 auth_mode 的 legacy tokens 快照仍采用本机 ChatGPT 凭据', async (t) => {
  const files = await fixture(t);
  const login = localLogin();
  delete login.auth_mode;
  await files.writeAuth(login);
  assert.deepEqual(await resolveLocalAuthentication(files.options), {
    mode: 'local-chatgpt',
    headers: { authorization: `Bearer ${ACCESS_TOKEN}`, 'chatgpt-account-id': ACCOUNT_ID },
  });
});

test('auto 在没有登录文件、仅 API Key 或其他认证模式时使用托管占位符', async (t) => {
  const files = await fixture(t);
  assert.deepEqual(await resolveLocalAuthentication(files.options), MANAGED);
  for (const login of [
    { OPENAI_API_KEY: OTHER_SECRET },
    { auth_mode: 'apikey', OPENAI_API_KEY: OTHER_SECRET, tokens: localLogin().tokens },
    { auth_mode: 'externalAuth', tokens: localLogin().tokens },
    { auth_mode: '', tokens: localLogin().tokens },
    { auth_mode: false, tokens: localLogin().tokens },
    { auth_mode: 0, tokens: localLogin().tokens },
  ]) {
    await files.writeAuth(login);
    const result = await resolveLocalAuthentication(files.options);
    assert.deepEqual(result, MANAGED);
    assertSafe(result);
  }
});

test('local-chatgpt 强制模式拒绝缺失文件、API Key 与不完整登录快照', async (t) => {
  const files = await fixture(t);
  const options = { ...files.options, mode: 'local-chatgpt' };
  await assertSafeRejection(() => resolveLocalAuthentication(options));
  for (const login of [
    { OPENAI_API_KEY: OTHER_SECRET },
    { auth_mode: 'apikey', tokens: localLogin().tokens },
    { auth_mode: 'chatgpt', tokens: { refresh_token: OTHER_SECRET, account_id: ACCOUNT_ID } },
    { auth_mode: 'chatgpt', tokens: { access_token: ACCESS_TOKEN } },
  ]) {
    await files.writeAuth(login);
    await assertSafeRejection(() => resolveLocalAuthentication(options));
  }
});

test('本机认证目录依次使用显式 codexHome、CODEX_HOME 和指定主目录', async (t) => {
  const files = await fixture(t);
  const explicit = await files.writeAuth(localLogin('fixture-explicit-token', 'fixture-explicit-account'), path.join(files.root, 'explicit'));
  const environment = await files.writeAuth(localLogin('fixture-env-token', 'fixture-env-account'), path.join(files.root, 'environment'));
  await files.writeAuth(localLogin('fixture-home-token', 'fixture-home-account'));
  for (const [options, token, account] of [
    [{ ...files.options, codexHome: explicit, env: { CODEX_HOME: environment } }, 'fixture-explicit-token', 'fixture-explicit-account'],
    [{ ...files.options, env: { CODEX_HOME: environment } }, 'fixture-env-token', 'fixture-env-account'],
    [files.options, 'fixture-home-token', 'fixture-home-account'],
  ]) {
    assert.deepEqual(await resolveLocalAuthentication(options), {
      mode: 'local-chatgpt', headers: { authorization: `Bearer ${token}`, 'chatgpt-account-id': account },
    });
  }
  assert.deepEqual(await resolveLocalAuthentication({
    ...files.options, codexHome: path.join(files.root, 'missing-explicit'), env: { CODEX_HOME: environment },
  }), MANAGED, '显式目录缺少文件时不得偷读其他目录的账号');
});

test('proxy-managed 不打开、检查或读取任何本机登录文件', async (t) => {
  const files = await fixture(t);
  let accesses = 0;
  const blockedFileSystem = new Proxy({}, {
    get() {
      return () => { accesses++; throw new Error(`不得读取 ${OTHER_SECRET}`); };
    },
  });
  const resolveIsolated = await loadWithFileSystem(blockedFileSystem);
  const result = await resolveIsolated({ ...files.options, codexHome: files.codexHome, mode: 'proxy-managed' });
  assert.deepEqual(jsonRoundTrip(result), MANAGED);
  assert.equal(accesses, 0);
});

test('未知认证模式与非法配置路径只返回安全错误，不回显输入', async (t) => {
  const files = await fixture(t);
  for (const overrides of [
    { mode: `unsupported-${OTHER_SECRET}` },
    { codexHome: `relative-${OTHER_SECRET}` },
    { codexHome: path.join(files.root, `${OTHER_SECRET}\u0000`) },
  ]) {
    await assertSafeRejection(() => resolveLocalAuthentication({ ...files.options, ...overrides }));
  }
});

test('损坏 JSON、无效根对象与超过 1 MiB 的文件不会泄露登录正文', async (t) => {
  const files = await fixture(t);
  const tooLarge = JSON.stringify({ ...localLogin(), padding: 'x'.repeat(MAX_AUTH_BYTES) });
  for (const content of [
    `{"fixture":"${OTHER_SECRET}","tokens":`,
    JSON.stringify([localLogin()]),
    'null',
    tooLarge,
  ]) {
    await files.writeAuth(content);
    for (const mode of ['auto', 'local-chatgpt']) {
      await assertSafeRejection(() => resolveLocalAuthentication({ ...files.options, mode }));
    }
  }
});

test('恰好 1 MiB 的登录文件仍可读取，超过上限按字节拒绝', async (t) => {
  const files = await fixture(t);
  const login = { ...localLogin(), padding: '' };
  login.padding = 'x'.repeat(MAX_AUTH_BYTES - Buffer.byteLength(JSON.stringify(login)));
  const atLimit = JSON.stringify(login);
  assert.equal(Buffer.byteLength(atLimit), MAX_AUTH_BYTES);
  await files.writeAuth(atLimit);
  assert.equal((await resolveLocalAuthentication(files.options)).headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  await files.writeAuth(atLimit.replace(/x{3}/, '界界'));
  assert.ok(Buffer.byteLength(atLimit.replace(/x{3}/, '界界')) > MAX_AUTH_BYTES);
  await assertSafeRejection(() => resolveLocalAuthentication(files.options));
});

test('文件权限错误不携带系统错误、路径或密钥返回调用方', async (t) => {
  const files = await fixture(t);
  const fileError = Object.assign(new Error(`EACCES ${files.root} ${OTHER_SECRET}`), {
    code: 'EACCES', path: path.join(files.root, OTHER_SECRET, 'auth.json'),
  });
  const failingFileSystem = new Proxy({}, { get: () => async () => { throw fileError; } });
  const resolveIsolated = await loadWithFileSystem(failingFileSystem);
  for (const mode of ['auto', 'local-chatgpt']) {
    await assertSafeRejection(
      () => resolveIsolated({ ...files.options, mode }),
      [OTHER_SECRET, files.root, 'EACCES'],
    );
  }
});

test('无效 access_token 与 account_id 在生成 HTTP 头之前被安全拒绝', async (t) => {
  const files = await fixture(t);
  const invalidTokens = [
    '', ' ', ` ${OTHER_SECRET}`, `${OTHER_SECRET} `, `with space-${OTHER_SECRET}`,
    `\t${OTHER_SECRET}`, `${OTHER_SECRET}\u00a0`, `${OTHER_SECRET}\r\nheader: injected`,
    `${OTHER_SECRET}\u0000`, `${OTHER_SECRET}\u007f`, 'x'.repeat(16385), 123, [ACCESS_TOKEN],
  ];
  for (const accessToken of invalidTokens) {
    await files.writeAuth(localLogin(accessToken));
    await assertSafeRejection(() => resolveLocalAuthentication(files.options));
  }
  const invalidAccounts = ['', ' ', `${OTHER_SECRET}\r\n`, `${OTHER_SECRET}\u0000`, 'x'.repeat(513), 123, [ACCOUNT_ID]];
  for (const accountId of invalidAccounts) {
    await files.writeAuth(localLogin(ACCESS_TOKEN, accountId));
    await assertSafeRejection(() => resolveLocalAuthentication(files.options));
  }
  await files.writeAuth(localLogin('x'.repeat(16384), 'a'.repeat(512)));
  const boundary = await resolveLocalAuthentication(files.options);
  assert.equal(boundary.headers.authorization, `Bearer ${'x'.repeat(16384)}`);
  assert.equal(boundary.headers['chatgpt-account-id'], 'a'.repeat(512));
});

test('本机凭据仅在 loopback HTTP 上游出现，跨宿主 DTO 和所有会话结果都不包含凭据', { timeout: 5000 }, async (t) => {
  const files = await fixture(t);
  await files.writeAuth(localLogin());
  const harness = await rpcHarness(t, files.options);
  const response = await exchange(harness.port);
  assert.equal(response.status, 200);
  assert.equal(response.body, 'fixture-response');
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(harness.requests[0].headers['chatgpt-account-id'], ACCOUNT_ID);
  const begin = harness.calls.find(call => call.method === 'begin');
  assert.equal(Object.hasOwn(begin.argument.headers, 'authorization'), false);
  assert.equal(Object.hasOwn(begin.argument.headers, 'chatgpt-account-id'), false);
  assertSafe(harness.calls);
  assertSafe(harness.broker.status());
  assertSafe(response);
  assert.equal(JSON.stringify(harness.calls).includes(SERVER_TOKEN), false, '服务器登录头也不进入 RPC');
  assert.deepEqual(await harness.rpc('authStatus'), { mode: 'local-chatgpt' });
  assertSafe(harness.calls);
});

test('只有 API Key 的文件在真实 HTTP 转发中仍使用托管占位符', { timeout: 5000 }, async (t) => {
  const files = await fixture(t);
  await files.writeAuth({ OPENAI_API_KEY: OTHER_SECRET });
  const harness = await rpcHarness(t, files.options);
  assert.equal((await exchange(harness.port)).status, 200);
  assert.equal(harness.requests[0].headers.authorization, 'Bearer PROXY_MANAGED');
  assert.equal(harness.requests[0].headers['chatgpt-account-id'], undefined);
  assertSafe(harness.calls);
});

test('每次 begin 都重新读取本机登录快照，切换账号后下一请求立即采用新凭据', { timeout: 5000 }, async (t) => {
  const files = await fixture(t);
  await files.writeAuth(localLogin());
  const harness = await rpcHarness(t, files.options);
  await exchange(harness.port);
  const nextToken = `${ACCESS_TOKEN}-after-switch`;
  const nextAccount = `${ACCOUNT_ID}-after-switch`;
  await files.writeAuth(localLogin(nextToken, nextAccount));
  await exchange(harness.port);
  assert.deepEqual(harness.requests.map(request => [request.headers.authorization, request.headers['chatgpt-account-id']]), [
    [`Bearer ${ACCESS_TOKEN}`, ACCOUNT_ID], [`Bearer ${nextToken}`, nextAccount],
  ]);
  assertSafe(harness.calls, [ACCESS_TOKEN, ACCOUNT_ID, OTHER_SECRET, nextToken, nextAccount]);
  const stored = JSON.parse(await fs.readFile(path.join(files.codexHome, 'auth.json'), 'utf8'));
  assert.deepEqual(stored, localLogin(nextToken, nextAccount));
});

test('远程 DTO 内伪造 trustedAuth 字段无效，默认头只使用托管占位符', { timeout: 5000 }, async (t) => {
  const upstream = await mockUpstream(t);
  const broker = new LocalBroker({ upstreamOrigin: upstream.upstreamOrigin, idleTimeoutMs: 5000 });
  t.after(() => broker.dispose());
  const opened = broker.begin(jsonRoundTrip({
    method: 'POST', path: '/v1/responses',
    headers: { Authorization: `Bearer ${SERVER_TOKEN}`, 'ChatGPT-Account-Id': 'fixture-server-account' },
    trustedAuth: { authorization: `Bearer ${ACCESS_TOKEN}`, 'chatgpt-account-id': ACCOUNT_ID },
    trustedLocalHeaders: { authorization: `Bearer ${ACCESS_TOKEN}`, 'chatgpt-account-id': ACCOUNT_ID },
  }));
  const result = await drain(broker, opened);
  assert.equal(upstream.requests[0].headers.authorization, 'Bearer PROXY_MANAGED');
  assert.equal(upstream.requests[0].headers['chatgpt-account-id'], undefined);
  assertSafe(result);
});

test('本机可信头仅允许鉴权字段，拒绝额外字段、数组和头注入而不泄露值', async (t) => {
  const broker = new LocalBroker();
  t.after(() => broker.dispose());
  const request = { method: 'POST', path: '/v1/responses', headers: {} };
  for (const headers of [
    { authorization: `Bearer ${ACCESS_TOKEN}`, 'x-api-key': OTHER_SECRET },
    { host: OTHER_SECRET },
    { authorization: [ACCESS_TOKEN] },
    { authorization: `Bearer ${ACCESS_TOKEN}\r\nx-injected: ${OTHER_SECRET}` },
    { authorization: `Bearer ${ACCESS_TOKEN}`, 'chatgpt-account-id': `${ACCOUNT_ID}\u0000` },
    [], null,
  ]) {
    await assertSafeRejection(async () => broker.begin(request, headers));
    assert.equal(broker.status().activeRequests, 0);
  }
});

test('携带本机凭据的上游响应重定向不被跟随，凭据不暴露在返回对象', { timeout: 5000 }, async (t) => {
  const files = await fixture(t);
  await files.writeAuth(localLogin());
  const destination = await mockUpstream(t);
  const source = await mockUpstream(t, (_request, response) => {
    response.writeHead(302, { location: `${destination.upstreamOrigin}/v1/responses` });
    response.end('fixture-redirect-response');
  });
  const broker = new LocalBroker({ upstreamOrigin: source.upstreamOrigin, idleTimeoutMs: 5000 });
  t.after(() => broker.dispose());
  const auth = await resolveLocalAuthentication(files.options);
  const result = await drain(broker, broker.begin({ method: 'GET', path: '/v1/models', headers: {} }, auth.headers));
  assert.equal(result.ended.status, 302);
  assert.equal(source.requests[0].headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(destination.requests.length, 0, '重定向目的地不得收到凭据或请求');
  assertSafe(result);
});

test('可信本机鉴权也不能放宽 broker 的 loopback origin 与请求路径限制', async (t) => {
  const files = await fixture(t);
  await files.writeAuth(localLogin());
  const auth = await resolveLocalAuthentication(files.options);
  for (const upstreamOrigin of ['https://example.test', 'http://192.0.2.1:2900', 'http://127.0.0.1.example.test']) {
    await assertSafeRejection(async () => new LocalBroker({ upstreamOrigin }));
  }
  const broker = new LocalBroker();
  t.after(() => broker.dispose());
  for (const route of [
    { method: 'POST', path: `https://example.test/${OTHER_SECRET}` },
    { method: 'POST', path: '/v1/responses/../outside' },
    { method: 'GET', path: '/auth.json' },
  ]) {
    await assertSafeRejection(async () => broker.begin({ ...route, headers: {} }, auth.headers));
  }
  assert.equal(broker.status().activeRequests, 0);
});
