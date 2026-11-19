'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const { LocalBroker, isClaudePath } = require('../local/src/broker');
const { RemoteProxy } = require('../remote/src/proxy');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function body(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function open(port, target, payload = '{}', headers = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: target, method, agent: false,
      headers: { 'content-type': 'application/json', ...headers },
    });
    request.on('error', reject);
    request.once('response', response => {
      response.on('error', () => {});
      resolve({ request, response });
    });
    request.end(payload);
  });
}

async function exchange(port, target, payload, headers, method) {
  const { response } = await open(port, target, payload, headers, method);
  return { status: response.statusCode, headers: response.headers, body: await body(response) };
}

async function harness(t, handler, authentication = () => { throw new Error('Synthetic authentication resolver must not run for Claude'); }) {
  const errors = [];
  const sockets = new Set();
  const upstream = http.createServer((request, response) => {
    Promise.resolve().then(() => handler(request, response)).catch(error => { errors.push(error); response.destroy(error); });
  });
  upstream.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const commands = new Map();
  const calls = [];
  const state = { authCalls: 0, broker: undefined };
  const context = { subscriptions: [] };
  const settings = { upstreamOrigin: `http://127.0.0.1:${upstream.address().port}` };
  const vscode = {
    commands: {
      registerCommand(name, callback) {
        assert.equal(commands.has(name), false);
        commands.set(name, callback);
        return { dispose() { commands.delete(name); } };
      },
    },
    workspace: {
      getConfiguration(namespace) {
        assert.equal(namespace, 'codexLocalBridge');
        return { get(name, fallback) { return settings[name] ?? fallback; } };
      },
      onDidChangeConfiguration() { return { dispose() {} }; },
    },
    window: {
      showInformationMessage() {},
      showErrorMessage() { assert.fail('模拟本机配置应有效'); },
    },
  };
  class TrackingBroker extends LocalBroker {
    constructor(options) { super(options); state.broker = this; }
  }
  const filename = path.resolve(__dirname, '../local/src/extension.js');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const overrides = {
    vscode,
    './broker': { LocalBroker: TrackingBroker, isClaudePath },
    './local-auth': { resolveLocalAuthentication() { state.authCalls++; return authentication(); } },
    './model-discovery': { discoverModels() { assert.fail('模型转发不应读取模型目录或本机文件'); } },
    './installer': { registerRemoteInstaller() {} },
  };
  // Read only extension source; every user-state dependency is injected.
  const sandbox = vm.createContext({});
  const execute = new vm.Script(wrap(fs.readFileSync(filename, 'utf8')), { filename }).runInContext(sandbox);
  execute(module.exports, name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name), module, filename, path.dirname(filename));
  module.exports.activate(context);
  const rpc = async (method, argument) => {
    const wire = JSON.parse(JSON.stringify({ method, argument }));
    calls.push(wire);
    const callback = commands.get(`codexLocalBridge.local.${wire.method}`);
    assert.equal(typeof callback, 'function');
    return JSON.parse(JSON.stringify(await callback(wire.argument)));
  };
  const proxy = new RemoteProxy({ rpc, port: 0 });
  t.after(async () => {
    // Dispose local sessions first so failures cannot leave a long stream alive.
    for (const subscription of context.subscriptions.slice().reverse()) subscription.dispose();
    await proxy.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
    assert.deepEqual(errors, [], '模拟上游不应出现未处理错误');
  });
  const address = await proxy.start();
  return { ...address, calls, state };
}

test('Claude Messages JSON 与工具调用原样转发，远程凭据不进入 RPC 或本机上游', async t => {
  const requests = [];
  const result = { id: 'fixture-message', type: 'message', content: [{ type: 'tool_use', id: 'fixture-tool', name: 'read', input: { file: 'fixture.txt' } }] };
  const h = await harness(t, async (request, response) => {
    requests.push({ path: request.url, headers: request.headers, body: JSON.parse((await body(request)).toString()) });
    response.writeHead(200, { 'content-type': 'application/json', 'request-id': 'fixture-request' });
    response.end(JSON.stringify(result));
  });
  const payload = { model: 'fixture-claude-model', max_tokens: 128, messages: [{ role: 'user', content: 'hello' }], tools: [{ name: 'read', input_schema: { type: 'object' } }] };
  const secrets = ['synthetic-remote-authorization', 'synthetic-remote-api-key', 'synthetic-remote-account'];
  const received = await exchange(h.port, '/v1/messages', JSON.stringify(payload), {
    Authorization: `Bearer ${secrets[0]}`, 'X-aPi-KeY': secrets[1], 'ChatGPT-Account-ID': secrets[2],
    'anthropic-version': '2023-06-01', 'anthropic-beta': 'fixture-beta',
  });
  assert.equal(received.status, 200);
  assert.deepEqual(JSON.parse(received.body), result);
  assert.equal(received.headers['request-id'], 'fixture-request');
  assert.equal(requests[0].path, '/v1/messages');
  assert.deepEqual(requests[0].body, payload);
  assert.equal(requests[0].headers.authorization, 'Bearer PROXY_MANAGED');
  assert.equal(requests[0].headers['x-api-key'], undefined);
  assert.equal(requests[0].headers['chatgpt-account-id'], undefined);
  assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(requests[0].headers['anthropic-beta'], 'fixture-beta');
  const begin = h.calls.find(call => call.method === 'begin');
  assert.equal(begin.argument.headers.authorization, undefined);
  assert.equal(begin.argument.headers['x-api-key'], undefined);
  assert.equal(begin.argument.headers['chatgpt-account-id'], undefined);
  for (const secret of secrets) assert.equal(JSON.stringify(h.calls).includes(secret), false);
  assert.equal(h.state.authCalls, 0);
});

test('Claude 精确 beta 查询保留，count_tokens 的成功与上游 404 原样返回', async t => {
  const paths = [];
  const missing = { type: 'error', error: { type: 'not_found_error', message: 'Synthetic unsupported counting endpoint' } };
  const h = await harness(t, async (request, response) => {
    paths.push(request.url);
    await body(request);
    const unsupported = request.url === '/v1/messages/count_tokens?beta=true';
    response.writeHead(unsupported ? 404 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(unsupported ? missing : { input_tokens: 3 }));
  });
  for (const target of ['/v1/messages?beta=true', '/v1/messages/count_tokens', '/v1/messages/count_tokens?beta=true']) {
    const received = await exchange(h.port, target);
    assert.equal(received.status, target.endsWith('count_tokens?beta=true') ? 404 : 200);
    assert.deepEqual(JSON.parse(received.body), target.endsWith('count_tokens?beta=true') ? missing : { input_tokens: 3 });
  }
  assert.deepEqual(paths, ['/v1/messages?beta=true', '/v1/messages/count_tokens', '/v1/messages/count_tokens?beta=true']);
  assert.equal(h.state.authCalls, 0);
});

test('Claude SSE 首事件不等待完整响应，超过跨端块大小的事件保持逐字完整', async t => {
  const finish = deferred();
  const started = 'event: message_start\ndata: {"type":"message_start"}\n\n';
  const delta = 'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '流'.repeat(70000) } }) + '\n\n';
  const stopped = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  t.after(() => finish.resolve());
  const h = await harness(t, async (request, response) => {
    await body(request);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(started);
    await finish.promise;
    if (!response.destroyed) response.end(delta + stopped);
  });
  const { response } = await open(h.port, '/v1/messages?beta=true', '{"stream":true}');
  const first = await within(new Promise(resolve => response.once('data', resolve)), 'SSE 首块未及时到达');
  assert.equal(first.toString(), started);
  const chunks = [first];
  response.on('data', chunk => chunks.push(chunk));
  const ended = new Promise((resolve, reject) => { response.once('end', resolve); response.once('error', reject); });
  finish.resolve();
  await within(ended, 'SSE 未结束');
  assert.equal(Buffer.concat(chunks).toString(), started + delta + stopped);
  assert.ok(h.calls.filter(call => call.method === 'read' && call.argument.maxBytes === 65536).length > 2);
  assert.equal(h.state.authCalls, 0);
});

test('Claude 客户端取消会终止本机长流并释放会话', async t => {
  const closed = deferred();
  const h = await harness(t, async (request, response) => {
    await body(request);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: message_start\ndata: {}\n\n');
    response.once('close', () => closed.resolve());
  });
  const { response } = await open(h.port, '/v1/messages', '{"stream":true}');
  await within(new Promise(resolve => response.once('data', resolve)), '首块未到达');
  response.destroy();
  await within(closed.promise, '本机长流没有被取消');
  const released = async () => {
    while (h.state.broker.status().activeRequests) await new Promise(resolve => setTimeout(resolve, 5));
  };
  await within(released(), '本机会话没有被释放');
  assert.ok(h.calls.some(call => call.method === 'cancel'));
  assert.equal(h.state.authCalls, 0);
});

test('Codex 和 Claude 并发流互不串流，只有 Codex 加载本机 ChatGPT 认证', async t => {
  const snapshots = [];
  const token = 'synthetic-local-chatgpt-token';
  const account = 'synthetic-local-chatgpt-account';
  const h = await harness(t, async (request, response) => {
    const payload = JSON.parse((await body(request)).toString());
    snapshots.push({ path: request.url, headers: request.headers, payload });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ marker: payload.marker }) + '\n\n');
    await new Promise(resolve => setImmediate(resolve));
    response.end('data: ' + JSON.stringify({ done: payload.marker }) + '\n\n');
  }, () => ({ mode: 'local-chatgpt', headers: { authorization: `Bearer ${token}`, 'chatgpt-account-id': account } }));
  const all = Array.from({ length: 8 }, (_, index) => ({ target: index % 2 ? '/v1/messages' : '/v1/responses', marker: `fixture-${index}` }));
  const results = await Promise.all(all.map(item => exchange(h.port, item.target, JSON.stringify({ marker: item.marker, stream: true }))));
  for (let index = 0; index < all.length; index++) {
    assert.equal(results[index].status, 200);
    assert.equal(results[index].body.toString(), 'data: ' + JSON.stringify({ marker: all[index].marker }) + '\n\ndata: ' + JSON.stringify({ done: all[index].marker }) + '\n\n');
  }
  assert.equal(h.state.authCalls, 4);
  for (const request of snapshots) {
    const claude = request.path === '/v1/messages';
    assert.equal(request.headers.authorization, claude ? 'Bearer PROXY_MANAGED' : `Bearer ${token}`);
    assert.equal(request.headers['chatgpt-account-id'], claude ? undefined : account);
    assert.equal(request.headers['x-api-key'], undefined);
  }
  assert.equal(JSON.stringify(h.calls).includes(token), false);
  assert.equal(JSON.stringify(h.calls).includes(account), false);
});

test('本机 broker 二次拦截混合大小写凭据，Claude 即使误传本机可信头也不使用它', async t => {
  const received = [];
  const h = await harness(t, async (request, response) => {
    received.push(request.headers);
    await body(request);
    response.end('fixture');
  });
  const broker = h.state.broker;
  const { id } = broker.begin({ method: 'POST', path: '/v1/messages', headers: {
    Authorization: 'Bearer synthetic-remote-token', 'X-API-KEY': 'synthetic-key', 'ChatGPT-Account-ID': 'synthetic-account',
  } }, { authorization: 'Bearer synthetic-local-token', 'chatgpt-account-id': 'synthetic-local-account' });
  assert.equal((await broker.end({ id })).status, 200);
  while (!(await broker.read({ id, waitMs: 1000 })).done) { /* Drain fixture. */ }
  broker.cancel({ id });
  assert.equal(received[0].authorization, 'Bearer PROXY_MANAGED');
  assert.equal(received[0]['x-api-key'], undefined);
  assert.equal(received[0]['chatgpt-account-id'], undefined);
  assert.equal(h.state.authCalls, 0);
});

test('Claude 未知查询、额外路径、穿越和绝对 URL 在跨端 RPC 之前被拒绝', async t => {
  const h = await harness(t, () => assert.fail('禁止路径不应到达上游'));
  const targets = [
    '/v1/messages?beta=false', '/v1/messages?beta=true&other=true', '/v1/messages?other=true',
    '/v1/messages/count_tokens?beta=true&other=true', '/v1/messages/', '/v1/messages/extra',
    '/v1/%6dessages', '/v1/../v1/messages', '//127.0.0.1/v1/messages',
    'http://127.0.0.1/v1/messages', '/api/hello',
  ];
  for (const target of targets) {
    assert.equal((await exchange(h.port, target)).status, 404);
    assert.throws(() => h.state.broker.begin({ method: 'POST', path: target }), /Unsupported/);
  }
  assert.equal((await exchange(h.port, '/v1/messages', '', {}, 'GET')).status, 405);
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.authCalls, 0);
});
