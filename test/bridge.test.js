'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { networkInterfaces } = require('node:os');
const { LocalBroker } = require('../local/src/broker');
const { RemoteProxy } = require('../remote/src/proxy');

const TOKEN = 'integration-test-token';
const LIMIT = 32 * 1024 * 1024;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, message, milliseconds = 4000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 4000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
    stream.once('aborted', () => reject(new Error('HTTP response aborted')));
  });
}

function openRequest(port, { method = 'POST', path = '/v1/responses', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { authorization: `Bearer ${TOKEN}`, ...headers };
    for (const key of Object.keys(requestHeaders)) {
      if (requestHeaders[key] === undefined) delete requestHeaders[key];
    }
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      agent: false,
      headers: requestHeaders,
    });
    request.once('error', reject);
    request.once('response', (response) => {
      // 取消测试会主动销毁 response；这里也监听错误，避免未处理事件。
      response.on('error', () => {});
      resolve({ request, response });
    });
    request.end(body);
  });
}

async function exchange(port, options) {
  const { response } = await openRequest(port, options);
  return {
    status: response.statusCode,
    headers: response.headers,
    body: await readBody(response),
  };
}

async function createHarness(t, handler, options = {}) {
  const upstreamErrors = [];
  const sockets = new Set();
  const upstream = http.createServer((request, response) => {
    Promise.resolve().then(() => handler(request, response)).catch((error) => {
      upstreamErrors.push(error);
      response.destroy(error);
    });
  });
  upstream.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const broker = new LocalBroker({
    upstreamOrigin,
    idleTimeoutMs: 5000,
    maxRequestBytes: LIMIT,
    maxQueuedBytes: 4 * 1024 * 1024,
    ...options.broker,
  });
  const calls = [];
  let maxActiveRequests = 0;
  // 强制经过 JSON 往返，不能让 Buffer、HTTP 对象或对象引用跨主机传递。
  const rpc = async (method, args) => {
    const wire = JSON.parse(JSON.stringify({ method, args }));
    calls.push(wire);
    assert.equal(typeof broker[wire.method], 'function', `未知 RPC 方法：${wire.method}`);
    try {
      const result = await broker[wire.method](wire.args);
      maxActiveRequests = Math.max(maxActiveRequests, (await broker.status()).activeRequests);
      return JSON.parse(JSON.stringify(result));
    } catch (error) {
      const remoteError = JSON.parse(JSON.stringify({
        message: error.message,
        name: error.name,
        code: error.code,
      }));
      throw Object.assign(new Error(remoteError.message), remoteError);
    }
  };
  const proxy = new RemoteProxy({
    rpc, ...(options.tokenless ? {} : { token: TOKEN }), port: 0, ...options.proxy,
  });
  let started;
  t.after(async () => {
    // 即使流式测试超时，也先终止本机请求以保证测试进程能够退出。
    await broker.dispose();
    for (const socket of sockets) socket.destroy();
    await proxy.stop();
    await new Promise((resolve) => upstream.close(resolve));
    assert.deepEqual(upstreamErrors, [], '模拟上游不应出现内部错误');
  });
  started = await proxy.start();
  assert.equal(started.baseUrl, `http://127.0.0.1:${started.port}/v1`);
  return {
    ...started,
    broker,
    proxy,
    calls,
    upstreamOrigin,
    get maxActiveRequests() { return maxActiveRequests; },
  };
}

test('Responses JSON 和必要头部穿过 JSON RPC，认证由本机端替换', { timeout: 10000 }, async (t) => {
  let received;
  const harness = await createHarness(t, async (request, response) => {
    received = {
      method: request.method,
      path: request.url,
      headers: request.headers,
      body: (await readBody(request)).toString('utf8'),
    };
    response.writeHead(201, { 'content-type': 'application/json', 'x-upstream-trace': 'local-123' });
    response.end('{"id":"resp_中文","output":[]}');
  });
  const payload = JSON.stringify({ model: 'local-model', input: '你好，bridge 🌉'.repeat(8000), stream: false });
  const result = await exchange(harness.port, {
    headers: {
      'content-type': 'application/json',
      'openai-beta': 'responses=v1',
      'x-request-trace': 'remote-456',
    },
    body: payload,
  });
  assert.equal(result.status, 201);
  assert.equal(result.headers['x-upstream-trace'], 'local-123');
  assert.equal(result.body.toString(), '{"id":"resp_中文","output":[]}');
  assert.equal(received.method, 'POST');
  assert.equal(received.path, '/v1/responses');
  assert.equal(received.body, payload);
  assert.equal(received.headers.authorization, 'Bearer PROXY_MANAGED');
  assert.equal(received.headers['content-type'], 'application/json');
  assert.equal(received.headers['openai-beta'], 'responses=v1');
  assert.equal(received.headers['x-request-trace'], 'remote-456');
  const writes = harness.calls.filter(({ method }) => method === 'write');
  assert.ok(writes.length > 1, '超过 64 KiB 的请求应拆分为多个 JSON RPC 数据块');
  assert.ok(writes.every(({ args }) => typeof args.data === 'string'));
  assert.ok(writes.every(({ args }) => Buffer.from(args.data, 'base64').length <= 65536));
  assert.equal(Buffer.concat(writes.map(({ args }) => Buffer.from(args.data, 'base64'))).toString(), payload);
  await waitFor(async () => (await harness.broker.status()).activeRequests === 0, '完成的请求未清理');
});

test('默认无令牌的 HTTP/SSE 经 JSON RPC 交给本机认证，服务器认证头不会跨端传递', { timeout: 10000 }, async (t) => {
  const received = [];
  const first = 'event: response.created\ndata: {"id":"local_auth_stream"}\n\n';
  const last = 'event: response.completed\ndata: {"id":"local_auth_stream"}\n\ndata: [DONE]\n\n';
  const harness = await createHarness(t, async (request, response) => {
    received.push({
      path: request.url,
      headers: request.headers,
      body: (await readBody(request)).toString(),
    });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(first);
    response.end(last);
  }, { tokenless: true });
  assert.equal(harness.proxy.server.address().address, '127.0.0.1');
  const body = JSON.stringify({ model: 'local-model', input: '本机统一认证', stream: true });
  for (const headers of [
    { authorization: undefined },
    { authorization: 'Bearer server-forged-token', 'chatgpt-account-id': 'server-forged-account' },
  ]) {
    const result = await exchange(harness.port, {
      headers: { 'content-type': 'application/json', ...headers }, body,
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-type'], 'text/event-stream');
    assert.equal(result.body.toString(), first + last);
  }
  assert.equal(received.length, 2);
  for (const request of received) {
    assert.equal(request.path, '/v1/responses');
    assert.equal(request.body, body);
    assert.equal(request.headers.authorization, 'Bearer PROXY_MANAGED');
    assert.equal(Object.hasOwn(request.headers, 'chatgpt-account-id'), false);
  }
  const begins = harness.calls.filter(({ method }) => method === 'begin');
  assert.equal(begins.length, 2);
  for (const { args } of begins) {
    assert.equal(Object.hasOwn(args.headers, 'authorization'), false);
    assert.equal(Object.hasOwn(args.headers, 'chatgpt-account-id'), false);
    assert.equal(args.headers['content-type'], 'application/json');
  }
  assert.doesNotMatch(JSON.stringify(harness.calls), /server-forged-token|server-forged-account/);
  await waitFor(async () => (await harness.broker.status()).activeRequests === 0, '免令牌 SSE 完成后 session 未清理');
});

test('默认无令牌时 health、models 和 compact 均可直接访问', { timeout: 10000 }, async (t) => {
  const received = [];
  const harness = await createHarness(t, async (request, response) => {
    received.push([request.method, request.url, request.headers.authorization]);
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ path: request.url }));
  }, { tokenless: true });
  for (const options of [
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/v1/models' },
    { path: '/v1/responses/compact', body: '{"previous_response_id":"resp_local"}' },
  ]) {
    const result = await exchange(harness.port, { ...options, headers: { authorization: undefined } });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).path, options.path);
  }
  assert.deepEqual(received, [
    ['GET', '/health', 'Bearer PROXY_MANAGED'],
    ['GET', '/v1/models', 'Bearer PROXY_MANAGED'],
    ['POST', '/v1/responses/compact', 'Bearer PROXY_MANAGED'],
  ]);
});

test('health、models 和 compact 路由都能到达本机对应端点', { timeout: 10000 }, async (t) => {
  const received = [];
  const harness = await createHarness(t, async (request, response) => {
    received.push([request.method, request.url, (await readBody(request)).toString()]);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ path: request.url }));
  });
  for (const options of [
    { method: 'GET', path: '/health', headers: { authorization: undefined } },
    { method: 'GET', path: '/v1/models' },
    { path: '/v1/responses/compact', body: '{"previous_response_id":"resp_1"}' },
  ]) {
    const result = await exchange(harness.port, options);
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).path, options.path);
  }
  assert.deepEqual(received, [
    ['GET', '/health', ''],
    ['GET', '/v1/models', ''],
    ['POST', '/v1/responses/compact', '{"previous_response_id":"resp_1"}'],
  ]);
  const status = await harness.broker.status();
  assert.equal(status.protocolVersion, 1);
  assert.equal(status.upstreamOrigin, harness.upstreamOrigin);
});

test('上游非 2xx 状态、响应头和错误正文原样返回', { timeout: 10000 }, async (t) => {
  const body = '{"error":{"message":"rate limited 中文","type":"rate_limit_error"}}';
  const harness = await createHarness(t, async (request, response) => {
    await readBody(request);
    response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' });
    response.end(body);
  });
  const result = await exchange(harness.port, { body: '{}' });
  assert.equal(result.status, 429);
  assert.equal(result.headers['retry-after'], '3');
  assert.equal(result.body.toString(), body);
});

test('带请求体的 GET 使用明确的分块边界，不会被上游解释为另一条 HTTP 消息', { timeout: 10000 }, async (t) => {
  const received = [];
  const harness = await createHarness(t, async (request, response) => {
    received.push({
      path: request.url,
      framing: request.headers['transfer-encoding'],
      body: (await readBody(request)).toString(),
    });
    response.end('fixture-get-response');
  });
  // 合成 HTTP 文本作为请求正文，必须完整留在已允许的路由中。
  const body = 'GET /outside-allowed-routes HTTP/1.1\r\nHost: fixture.invalid\r\n\r\n';
  for (const path of ['/health', '/v1/models']) {
    const result = await exchange(harness.port, {
      method: 'GET', path,
      headers: { 'content-length': String(Buffer.byteLength(body)) }, body,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), 'fixture-get-response');
  }
  assert.deepEqual(received, ['/health', '/v1/models'].map(path => ({ path, framing: 'chunked', body })));
  await waitFor(() => harness.broker.status().activeRequests === 0, 'GET 请求完成后 session 未清理');
});

test('SSE 首块在上游结束前到达，超过 64 KiB 的多块流无损传递', { timeout: 10000 }, async (t) => {
  const releaseTail = deferred();
  t.after(() => releaseTail.resolve());
  const first = 'event: response.created\ndata: {"id":"stream_1"}\n\n';
  const middle = `data: ${JSON.stringify({ text: '中🌉'.repeat(40 * 1024) })}\n\n`;
  const last = 'event: response.completed\ndata: {"id":"stream_1"}\n\ndata: [DONE]\n\n';
  let upstreamFinished = false;
  const harness = await createHarness(t, async (request, response) => {
    await readBody(request);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.flushHeaders();
    response.write(first);
    response.write(middle);
    await releaseTail.promise;
    upstreamFinished = true;
    response.end(last);
  });
  const { response } = await openRequest(harness.port, { body: '{"stream":true}' });
  const chunks = [];
  const firstSeen = deferred();
  response.on('data', (chunk) => {
    chunks.push(chunk);
    if (Buffer.concat(chunks).includes(Buffer.from(first))) firstSeen.resolve();
  });
  const completed = new Promise((resolve, reject) => {
    response.once('end', resolve);
    response.once('error', reject);
  });
  completed.catch(() => {});
  await within(firstSeen.promise, '代理缓冲了整个 SSE，首块未及时到达');
  assert.equal(upstreamFinished, false);
  assert.equal(response.headers['content-type'], 'text/event-stream');
  releaseTail.resolve();
  await within(completed, 'SSE 尾块未返回');
  assert.ok(Buffer.byteLength(middle) > 64 * 1024);
  assert.ok(chunks.length > 1);
  assert.equal(Buffer.concat(chunks).toString(), first + middle + last);
  await waitFor(async () => (await harness.broker.status()).activeRequests === 0, 'SSE 完成后 session 未清理');
});

test('客户端取消长流会关闭本机上游连接并释放 session', { timeout: 10000 }, async (t) => {
  const upstreamClosed = deferred();
  const harness = await createHarness(t, async (request, response) => {
    await readBody(request);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"started":true}\n\n');
    const timer = setInterval(() => response.write(': keepalive\n\n'), 20);
    response.once('close', () => {
      clearInterval(timer);
      upstreamClosed.resolve();
    });
  });
  const { request, response } = await openRequest(harness.port, { body: '{"stream":true}' });
  await within(new Promise((resolve) => response.once('data', resolve)), '长流首块未到达');
  assert.equal((await harness.broker.status()).activeRequests, 1);
  response.destroy();
  request.destroy();
  await within(upstreamClosed.promise, '客户端取消后本机上游连接仍未关闭');
  await waitFor(async () => (await harness.broker.status()).activeRequests === 0, '取消后 session 未清理');
  assert.ok(harness.calls.some(({ method }) => method === 'cancel'));
});

test('8 个并发流通过 JSON RPC 返回各自数据，不发生串流', { timeout: 12000 }, async (t) => {
  const allStarted = deferred();
  let started = 0;
  const harness = await createHarness(t, async (request, response) => {
    const { id } = JSON.parse(await readBody(request));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id, part: 0 })}\n\n`);
    if (++started === 8) allStarted.resolve();
    await allStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    response.write(`data: ${JSON.stringify({ id, part: 1 })}\n\n`);
    await new Promise((resolve) => setImmediate(resolve));
    response.end(`data: ${JSON.stringify({ id, part: 2 })}\n\n`);
  });
  const results = await within(Promise.all(Array.from({ length: 8 }, (_, id) => (
    exchange(harness.port, { body: JSON.stringify({ id, stream: true }) })
  ))), '并发流未全部完成', 6000);
  results.forEach((result, id) => {
    assert.equal(result.status, 200);
    const events = result.body.toString().trim().split('\n\n').map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(events, [0, 1, 2].map((part) => ({ id, part })));
  });
  assert.equal(started, 8);
  assert.equal(harness.maxActiveRequests, 8);
  await waitFor(async () => (await harness.broker.status()).activeRequests === 0, '并发请求后 session 未清理');
});

test('无效远程 token 在调用上游之前被拒绝', { timeout: 10000 }, async (t) => {
  let upstreamHits = 0;
  const logs = [];
  const harness = await createHarness(t, (request, response) => {
    upstreamHits++;
    response.end('unexpected');
  }, { proxy: { log: message => logs.push(message) } });
  for (const authorization of [undefined, '', 'Bearer wrong-token', 'Basic dXNlcjpwYXNz']) {
    const result = await exchange(harness.port, { headers: { authorization }, body: '{}' });
    assert.equal(result.status, 401);
  }
  assert.equal(upstreamHits, 0);
  assert.equal(harness.calls.filter(({ method }) => method === 'begin').length, 0);
  assert.equal((await harness.broker.status()).activeRequests, 0);
  assert.deepEqual(logs.filter(line => line.startsWith('桥接认证失败：')), [
    '桥接认证失败：missing', '桥接认证失败：missing',
    '桥接认证失败：mismatch', '桥接认证失败：mismatch',
  ]);
  for (const secret of [TOKEN, 'wrong-token', 'dXNlcjpwYXNz']) {
    assert.ok(logs.every(line => !line.includes(secret)), '鉴权日志不得包含令牌或认证头');
  }
});

test('auth-check 仅校验桥接令牌，正确、缺失及错误令牌均不调用本机或上游', { timeout: 10000 }, async (t) => {
  let upstreamHits = 0;
  const harness = await createHarness(t, (request, response) => {
    upstreamHits++;
    response.end('unexpected');
  });
  const accepted = await exchange(harness.port, { method: 'GET', path: '/bridge/auth-check' });
  assert.equal(accepted.status, 200);
  assert.deepEqual(JSON.parse(accepted.body), { authenticated: true });
  for (const authorization of [undefined, 'Bearer wrong-token']) {
    const rejected = await exchange(harness.port, {
      method: 'GET', path: '/bridge/auth-check', headers: { authorization },
    });
    assert.equal(rejected.status, 401);
  }
  assert.equal(upstreamHits, 0);
  assert.deepEqual(harness.calls, [], '令牌诊断不应发起任何跨端 RPC');
  assert.equal((await harness.broker.status()).activeRequests, 0);
});

test('默认 auth-check 免令牌报告本机 CC Switch 认证，不调用跨端 RPC 或上游', { timeout: 10000 }, async (t) => {
  let upstreamHits = 0;
  const harness = await createHarness(t, (request, response) => {
    upstreamHits++;
    response.end('unexpected');
  }, { tokenless: true });
  for (const authorization of [undefined, 'Bearer server-forged-token']) {
    const result = await exchange(harness.port, {
      method: 'GET', path: '/bridge/auth-check', headers: { authorization },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), {
      authenticated: true, authentication: 'local-cc-switch',
    });
  }
  assert.equal(upstreamHits, 0);
  assert.deepEqual(harness.calls, []);
  assert.equal((await harness.broker.status()).activeRequests, 0);
});

test('未知路由、错误方法、绝对 URL 和路径穿越均不能访问上游', { timeout: 10000 }, async (t) => {
  let upstreamHits = 0;
  const harness = await createHarness(t, (request, response) => {
    upstreamHits++;
    response.end('unexpected');
  });
  for (const options of [
    { method: 'GET', path: '/admin' },
    { method: 'POST', path: '/v1/files' },
    { method: 'GET', path: '/v1/responses' },
    { method: 'POST', path: '/v1/responses/../../admin' },
    { method: 'GET', path: '/v1/%2e%2e/admin' },
    { method: 'GET', path: `${harness.upstreamOrigin}/v1/models` },
    { method: 'GET', path: 'https://example.invalid/v1/models' },
  ]) {
    const result = await exchange(harness.port, options);
    assert.ok(result.status >= 400 && result.status < 500, `${options.method} ${options.path} 得到 ${result.status}`);
  }
  assert.equal(upstreamHits, 0);
  assert.equal((await harness.broker.status()).activeRequests, 0);
});

test('本机 broker 自身也拒绝任意路径和非回环上游', { timeout: 10000 }, async (t) => {
  for (const upstreamOrigin of [
    'https://api.openai.com',
    'http://example.invalid',
    'http://169.254.169.254',
    'file:///tmp/provider.sock',
    'http://127.0.0.1@evil.invalid',
    'http://127.0.0.1.evil.invalid',
  ]) {
    assert.throws(() => new LocalBroker({ upstreamOrigin }), `不应允许上游：${upstreamOrigin}`);
  }
  let upstreamHits = 0;
  const harness = await createHarness(t, (request, response) => {
    upstreamHits++;
    response.end('unexpected');
  });
  for (const path of ['/admin', '/v1/files', 'http://example.invalid/v1/models', '//example.invalid/v1/models']) {
    await assert.rejects(async () => harness.broker.begin({ method: 'GET', path, headers: {} }), `不应允许路径：${path}`);
  }
  assert.equal(upstreamHits, 0);
  assert.equal((await harness.broker.status()).activeRequests, 0);
});

test('停止远程代理会取消进行中的流并清理本机会话', { timeout: 10000 }, async (t) => {
  const upstreamClosed = deferred();
  const harness = await createHarness(t, async (request, response) => {
    await readBody(request);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"started":true}\n\n');
    const timer = setInterval(() => response.write(': still running\n\n'), 20);
    response.once('close', () => {
      clearInterval(timer);
      upstreamClosed.resolve();
    });
  });
  const { response } = await openRequest(harness.port, { body: '{"stream":true}' });
  await within(new Promise((resolve) => response.once('data', resolve)), '关闭测试的首块未到达');
  const clientClosed = new Promise((resolve) => response.once('close', resolve));
  await within(harness.proxy.stop(), '停止代理时被进行中的长流阻塞');
  await within(upstreamClosed.promise, '停止代理后上游连接未关闭');
  await within(clientClosed, '停止代理后客户端连接未关闭');
  assert.equal((await harness.broker.status()).activeRequests, 0);
  assert.ok(response.destroyed || response.readableEnded);
});

async function createRpcProxy(t, rpc, options = {}) {
  const proxy = new RemoteProxy({ rpc, port: 0, ...options });
  t.after(() => proxy.stop());
  return { proxy, ...(await proxy.start()) };
}

for (const stalledMethod of ['begin', 'read']) {
  test(`${stalledMethod} RPC 未返回时停止代理仍能完成，迟到的会话会被取消`, { timeout: 5000 }, async (t) => {
    const entered = deferred();
    const stalled = deferred();
    const cancelled = [];
    const { proxy, port } = await createRpcProxy(t, async (method, argument) => {
      if (method === stalledMethod) {
        entered.resolve();
        return stalled.promise;
      }
      if (method === 'begin') return { id: 'fixture-stalled-session' };
      if (method === 'end') return { status: 200, headers: { 'content-type': 'text/event-stream' } };
      if (method === 'cancel') { cancelled.push(argument.id); return { ok: true }; }
      return { ok: true };
    });
    const request = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/responses', agent: false,
    }, response => { response.on('error', () => {}); response.resume(); });
    request.on('error', () => {});
    t.after(() => request.destroy());
    request.end('{}');
    await within(entered.promise, '未进入待取消的 RPC');
    await within(proxy.stop(), '停止代理不应等待已断开的 RPC', 1000);
    assert.equal(proxy.pending.size, 0);
    if (stalledMethod === 'begin') {
      assert.deepEqual(cancelled, []);
      stalled.resolve({ id: 'fixture-stalled-session' });
      await waitFor(() => cancelled.length === 1, '迟到的 begin 会话没有被取消');
    } else {
      stalled.resolve({ data: '', done: true });
    }
    assert.deepEqual(cancelled, ['fixture-stalled-session']);
  });
}

test('跨宿主 begin 超时返回 502，迟到结果仍释放本机会话', { timeout: 5000 }, async (t) => {
  const opening = deferred();
  const cancelled = [];
  const { proxy, port } = await createRpcProxy(t, async (method, argument) => {
    if (method === 'begin') return opening.promise;
    if (method === 'cancel') { cancelled.push(argument.id); return { ok: true }; }
    assert.fail('begin 超时后不得继续请求');
  }, { rpcTimeoutMs: 50 });
  const response = await within(exchange(port, { body: '{}' }), 'RPC 超时后客户端未收到响应');
  assert.equal(response.status, 502);
  await waitFor(() => proxy.pending.size === 0, '超时请求未退出');
  opening.resolve({ id: 'fixture-late-session' });
  await waitFor(() => cancelled.length === 1, '超时后迟到的会话未清理');
  assert.deepEqual(cancelled, ['fixture-late-session']);
});

test('cancel RPC 未返回时仍会在期限内退出清理，不阻塞停止代理', { timeout: 5000 }, async (t) => {
  const cancelling = deferred();
  const { proxy, port } = await createRpcProxy(t, async method => {
    if (method === 'begin') return { id: 'fixture-cancelling-session' };
    if (method === 'end') return { status: 200, headers: {} };
    if (method === 'read') return { data: '', done: true };
    if (method === 'cancel') { cancelling.resolve(); return new Promise(() => {}); }
    return { ok: true };
  }, { rpcTimeoutMs: 50 });
  const response = await exchange(port, { body: '{}' });
  assert.equal(response.status, 200);
  await within(cancelling.promise, '未尝试清理会话');
  await within(proxy.stop(), 'cancel RPC 卡住时停止代理未返回', 1000);
  assert.equal(proxy.pending.size, 0);
});

test('本机上游不返回数据时空闲超时会释放连接和会话', { timeout: 5000 }, async (t) => {
  const closed = deferred();
  const harness = await createHarness(t, async (request, response) => {
    response.once('close', () => closed.resolve());
    await readBody(request);
    // 模拟已收完请求却永不返回响应头的本机上游。
  }, { broker: { idleTimeoutMs: 50 } });
  const result = await within(exchange(harness.port, { body: '{}' }), '上游空闲超时未结束请求');
  assert.equal(result.status, 502);
  await within(closed.promise, '空闲超时未关闭上游连接');
  await waitFor(() => harness.broker.status().activeRequests === 0, '空闲超时未释放 session');
});

test('远程请求体超限返回 413，并释放已创建的会话', { timeout: 10000 }, async (t) => {
  const harness = await createHarness(t, async (request, response) => {
    await readBody(request);
    response.end('{}');
  }, { proxy: { maxRequestBytes: 1024 } });
  for (const headers of [
    { 'content-type': 'application/json', 'content-length': '2048' },
    { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
  ]) {
    const result = await exchange(harness.port, { headers, body: Buffer.alloc(2048, 0x61) });
    assert.equal(result.status, 413);
    await waitFor(async () => (await harness.broker.status()).activeRequests === 0, '超限请求的 session 未清理');
  }
});

for (const tokenless of [false, true]) {
  test(`${tokenless ? '免令牌的' : ''}远程 HTTP 代理不能从本机非回环地址访问`, { timeout: 10000 }, async (t) => {
    const address = Object.values(networkInterfaces()).flat().find((entry) => (
      entry && entry.family === 'IPv4' && !entry.internal
    ))?.address;
    if (!address) return t.skip('当前环境没有非回环 IPv4 地址');
    const harness = await createHarness(t, (request, response) => response.end('unexpected'), { tokenless });
    const outcome = await within(new Promise((resolve) => {
      const request = http.get({ host: address, port: harness.port, path: '/health', agent: false });
      request.once('response', (response) => {
        response.resume();
        resolve({ accessible: true });
      });
      request.once('error', (error) => resolve({ accessible: false, code: error.code }));
      request.setTimeout(1500, () => request.destroy());
    }), '非回环地址连接未及时结束');
    assert.equal(outcome.accessible, false, '代理端口对非回环网卡开放');
    assert.equal(outcome.code, 'ECONNREFUSED');
  });
}
