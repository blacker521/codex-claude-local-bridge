'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const { discoverModels } = require('../local/src/model-discovery');

const MAX_BYTES = 1024 * 1024;
const SECRET = 'sk-fixture-only-model-discovery-secret';

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-model-discovery-test-'));
  const homeDirectory = path.join(root, 'home');
  await fs.mkdir(homeDirectory);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    // 每次调用都覆盖真实进程环境和主目录，绝不读取用户的 Codex 配置。
    options: { env: {}, homeDirectory },
    defaultCodexHome: path.join(homeDirectory, '.codex'),
    async writeConfig(directory, content) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'config.toml'), content, 'utf8');
      return directory;
    },
  };
}

async function createUpstream(t, handler) {
  const requests = [];
  const sockets = new Set();
  const errors = [];
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
    });
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
  return {
    upstreamOrigin: `http://127.0.0.1:${server.address().port}`,
    requests,
  };
}

function jsonResponse(response, body) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function assertSafeResult(result, forbidden = [SECRET]) {
  assert.ok(Array.isArray(result.models));
  assert.ok(Array.isArray(result.warnings));
  for (const warning of result.warnings) {
    assert.equal(typeof warning, 'string');
    assert.ok(warning.length <= 300, '警告应为简短提示，不能包含响应或配置正文');
  }
  for (const secret of forbidden) {
    assert.equal(JSON.stringify(result).includes(secret), false, '发现结果不得泄露配置、密钥或错误响应正文');
  }
}

function assertLocalFallback(result, id) {
  assert.deepEqual(result.models, [{ id, displayName: id, source: 'local-config' }]);
  assert.equal(result.currentModel, id);
  assertSafeResult(result);
}

test('OpenAI 模型目录使用真实 id、保留大小写并去重，发现请求使用托管鉴权', { timeout: 5000 }, async (t) => {
  const fixture = await createFixture(t);
  const upstream = await createUpstream(t, (_request, response) => jsonResponse(response, {
    data: [
      { id: 'Vendor/GPT-Next' },
      { id: 'Vendor/gpt-next' },
      { id: 'Vendor/Model With Space' },
      { id: 'Vendor/GPT-Next' },
      { display_name: 'GPT-5.4 Friendly Label' },
      { name: 'Another Friendly Label' },
      { id: '' },
      { id: 123 },
      null,
    ],
  }));
  const result = await discoverModels({ ...fixture.options, upstreamOrigin: upstream.upstreamOrigin });
  assert.deepEqual(result.models, [
    { id: 'Vendor/GPT-Next', displayName: 'Vendor/GPT-Next', source: 'api' },
    { id: 'Vendor/gpt-next', displayName: 'Vendor/gpt-next', source: 'api' },
    { id: 'Vendor/Model With Space', displayName: 'Vendor/Model With Space', source: 'api' },
  ]);
  assert.equal(result.currentModel, null);
  assert.deepEqual(upstream.requests, [{
    method: 'GET', path: '/v1/models', authorization: 'Bearer PROXY_MANAGED',
  }]);
  assertSafeResult(result);
});

test('Codex 模型目录分开保留 slug 和 display_name，只有展示名的行不能成为请求 ID', async (t) => {
  const fixture = await createFixture(t);
  const upstream = await createUpstream(t, (_request, response) => jsonResponse(response, {
    models: [
      { slug: 'Provider/Exact-Model', display_name: 'GPT-5.4 Friendly Label' },
      { slug: 'second-model', display_name: 'Second Model' },
      { slug: 'Provider/Exact-Model', display_name: '重复条目' },
      { display_name: 'Display Name Only' },
      { slug: '', display_name: 'Empty Slug' },
      { slug: null, display_name: 'Null Slug' },
      null,
    ],
  }));
  const result = await discoverModels({ ...fixture.options, upstreamOrigin: upstream.upstreamOrigin });
  assert.deepEqual(result.models.map(({ id }) => id), ['Provider/Exact-Model', 'second-model']);
  assert.equal(result.models[0].displayName, 'GPT-5.4 Friendly Label');
  assert.equal(result.models[1].displayName, 'Second Model');
  assert.ok(result.models.every(({ source }) => source === 'api'));
  assert.equal(result.currentModel, null);
  assertSafeResult(result);
});

test('API 成功仍读取当前模型，但不把本机模型混入 API 候选列表', async (t) => {
  const fixture = await createFixture(t);
  await fixture.writeConfig(fixture.defaultCodexHome, `model = "Local/Current-Model"\napi_key = "${SECRET}"\n`);
  const upstream = await createUpstream(t, (_request, response) => jsonResponse(response, {
    data: [{ id: 'Remote/Available-Model' }],
  }));
  const result = await discoverModels({ ...fixture.options, upstreamOrigin: upstream.upstreamOrigin });
  assert.deepEqual(result.models, [{
    id: 'Remote/Available-Model', displayName: 'Remote/Available-Model', source: 'api',
  }]);
  assert.equal(result.currentModel, 'Local/Current-Model');
  assertSafeResult(result);
});

test('空目录回退真实顶层 model，忽略注释、provider 与 profile 中的 model', async (t) => {
  const fixture = await createFixture(t);
  await fixture.writeConfig(fixture.defaultCodexHome, [
    '# model = "comment-model"',
    `api_key = "${SECRET}"`,
    'model = "Vendor/Current-2026" # 已选模型',
    'model_provider = "selected"',
    '[model_providers.selected]',
    'model = "provider-model"',
    `api_key = "${SECRET}-provider"`,
    '[profiles.example]',
    'model = "profile-model"',
    '',
  ].join('\n'));
  const upstream = await createUpstream(t, (_request, response) => jsonResponse(response, { models: [] }));
  const result = await discoverModels({ ...fixture.options, upstreamOrigin: upstream.upstreamOrigin });
  assertLocalFallback(result, 'Vendor/Current-2026');
});

test('没有可用 id 的 API 目录也回退本机模型，不从 display_name 猜 ID', async (t) => {
  const fixture = await createFixture(t);
  await fixture.writeConfig(fixture.defaultCodexHome, 'model = "Vendor/Real-ID"\n');
  const upstream = await createUpstream(t, (_request, response) => jsonResponse(response, {
    models: [{ display_name: 'GPT 5.4 Pretty Name' }, { slug: '' }],
  }));
  const result = await discoverModels({ ...fixture.options, upstreamOrigin: upstream.upstreamOrigin });
  assertLocalFallback(result, 'Vendor/Real-ID');
});

test('本机 TOML 支持基本字符串转义和字面量单引号，字符串中的 # 不作为注释', async (t) => {
  const fixture = await createFixture(t);
  const upstream = await createUpstream(t, (_request, response) => jsonResponse(response, { data: [] }));
  const cases = [
    { content: 'model = "Vendor/\\u0043ase-v2" # comment\n', expected: 'Vendor/Case-v2' },
    { content: "model = 'Vendor/Case#Model' # comment\n", expected: 'Vendor/Case#Model' },
    { content: "model = 'Vendor\\Literal'\n", expected: 'Vendor\\Literal' },
  ];
  for (const [index, { content, expected }] of cases.entries()) {
    await t.test(`字符串语法 ${index + 1}`, async () => {
      const codexHome = await fixture.writeConfig(path.join(fixture.root, `string-${index}`), content);
      const result = await discoverModels({ ...fixture.options, upstreamOrigin: upstream.upstreamOrigin, codexHome });
      assertLocalFallback(result, expected);
    });
  }
});

test('多行字符串和无效转义保守拒绝，不把其中看似 model 的正文当候选', async (t) => {
  const fixture = await createFixture(t);
  const upstream = await createUpstream(t, (_request, response) => jsonResponse(response, { data: [] }));
  const cases = [
    'model = """\nVendor/Multiline\n"""\n',
    "model = '''Vendor/Multiline'''\n",
    'notes = """\nmodel = "embedded-model"\n"""\n',
    "notes = '''\nmodel = 'embedded-literal-model'\n'''\n",
    'model = "Vendor/invalid\\qescape"\n',
    `model = "unterminated\napi_key = "${SECRET}"\n`,
  ];
  for (const [index, content] of cases.entries()) {
    await t.test(`保守解析 ${index + 1}`, async () => {
      const codexHome = await fixture.writeConfig(path.join(fixture.root, `unsupported-${index}`), content);
      const result = await discoverModels({ ...fixture.options, upstreamOrigin: upstream.upstreamOrigin, codexHome });
      assert.deepEqual(result.models, []);
      assert.equal(result.currentModel, null);
      assertSafeResult(result, [SECRET, 'unterminated', 'embedded-model', 'embedded-literal-model']);
    });
  }
});

test('只有注释或表内 model 时没有本机当前模型，也不读取配置中的其他字符串', async (t) => {
  const fixture = await createFixture(t);
  await fixture.writeConfig(fixture.defaultCodexHome, [
    '# model = "comment-only"',
    `api_key = "${SECRET}"`,
    '[model_providers.example]',
    'model = "provider-only"',
    '[profiles.test]',
    'model = "profile-only"',
    '',
  ].join('\n'));
  const upstream = await createUpstream(t, (_request, response) => jsonResponse(response, { data: [] }));
  const result = await discoverModels({ ...fixture.options, upstreamOrigin: upstream.upstreamOrigin });
  assert.deepEqual(result.models, []);
  assert.equal(result.currentModel, null);
  assertSafeResult(result, [SECRET, 'comment-only', 'provider-only', 'profile-only']);
});

test('Codex 配置路径依次采用显式 codexHome、env.CODEX_HOME 和传入的主目录', async (t) => {
  const fixture = await createFixture(t);
  const explicitHome = await fixture.writeConfig(path.join(fixture.root, 'explicit'), 'model = "explicit-model"\n');
  const envHome = await fixture.writeConfig(path.join(fixture.root, 'environment'), 'model = "env-model"\n');
  await fixture.writeConfig(fixture.defaultCodexHome, 'model = "home-model"\n');
  const upstream = await createUpstream(t, (_request, response) => jsonResponse(response, { data: [] }));
  const common = { ...fixture.options, upstreamOrigin: upstream.upstreamOrigin };
  assertLocalFallback(await discoverModels({ ...common, codexHome: explicitHome, env: { CODEX_HOME: envHome } }), 'explicit-model');
  assertLocalFallback(await discoverModels({ ...common, env: { CODEX_HOME: envHome } }), 'env-model');
  assertLocalFallback(await discoverModels(common), 'home-model');
});

test('显式配置目录缺少文件时不偷偷改读环境或默认目录', async (t) => {
  const fixture = await createFixture(t);
  const envHome = await fixture.writeConfig(path.join(fixture.root, 'environment'), 'model = "env-decoy"\n');
  await fixture.writeConfig(fixture.defaultCodexHome, 'model = "home-decoy"\n');
  const upstream = await createUpstream(t, (_request, response) => jsonResponse(response, { data: [] }));
  const result = await discoverModels({
    ...fixture.options,
    upstreamOrigin: upstream.upstreamOrigin,
    codexHome: path.join(fixture.root, 'missing-explicit'),
    env: { CODEX_HOME: envHome },
  });
  assert.deepEqual(result.models, []);
  assert.equal(result.currentModel, null);
  assertSafeResult(result);
});

test('HTTP 失败和无效 JSON 都回退本机模型，警告不包含响应正文', async (t) => {
  const fixture = await createFixture(t);
  await fixture.writeConfig(fixture.defaultCodexHome, 'model = "Local/Fallback"\n');
  for (const status of [503, 200]) {
    await t.test(`HTTP ${status}`, async (subtest) => {
      const upstream = await createUpstream(subtest, (_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(`invalid-json-body-${SECRET}`);
      });
      const result = await discoverModels({ ...fixture.options, upstreamOrigin: upstream.upstreamOrigin });
      assertLocalFallback(result, 'Local/Fallback');
      assert.ok(result.warnings.length > 0);
      assertSafeResult(result, [SECRET, 'invalid-json-body']);
    });
  }
});

test('API 超时结束等待后仍回退本机模型', { timeout: 5000 }, async (t) => {
  const fixture = await createFixture(t);
  await fixture.writeConfig(fixture.defaultCodexHome, 'model = "Local/After-Timeout"\n');
  const upstream = await createUpstream(t, () => {});
  const result = await discoverModels({
    ...fixture.options, upstreamOrigin: upstream.upstreamOrigin, timeoutMs: 50,
  });
  assertLocalFallback(result, 'Local/After-Timeout');
  assert.ok(result.warnings.length > 0);
  assert.equal(upstream.requests.length, 1);
});

test('API 重定向不被跟随，并保留本机回退', async (t) => {
  const fixture = await createFixture(t);
  await fixture.writeConfig(fixture.defaultCodexHome, 'model = "Local/After-Redirect"\n');
  const upstream = await createUpstream(t, (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(302, { location: `http://${request.headers.host}/redirect-target` });
      response.end(SECRET);
      return;
    }
    jsonResponse(response, { data: [{ id: 'redirect-target-model' }] });
  });
  const result = await discoverModels({ ...fixture.options, upstreamOrigin: upstream.upstreamOrigin });
  assertLocalFallback(result, 'Local/After-Redirect');
  assert.equal(upstream.requests.length, 1, '发现不能沿重定向访问另一个地址');
  assert.ok(result.warnings.length > 0);
});

test('超过 1 MiB 的 API 目录丢弃并回退，包含中文时按字节计量', async (t) => {
  const fixture = await createFixture(t);
  await fixture.writeConfig(fixture.defaultCodexHome, 'model = "Local/After-Limit"\n');
  const payload = JSON.stringify({ data: [{ id: 'too-large-api-model' }], padding: '界'.repeat(Math.ceil(MAX_BYTES / 3)) });
  assert.ok(Buffer.byteLength(payload) > MAX_BYTES);
  assert.ok(payload.length < MAX_BYTES, '该例区分字符数与 UTF-8 字节数');
  const upstream = await createUpstream(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    // 不依赖 Content-Length，验证流式接收期间也有大小限制。
    response.write(payload.slice(0, 100));
    response.end(payload.slice(100));
  });
  const result = await discoverModels({ ...fixture.options, upstreamOrigin: upstream.upstreamOrigin });
  assertLocalFallback(result, 'Local/After-Limit');
  assert.ok(result.warnings.length > 0);
});

test('超过 1 MiB 的配置文件不提取模型，正常 API 候选仍然可用', async (t) => {
  const fixture = await createFixture(t);
  await fixture.writeConfig(fixture.defaultCodexHome, `model = "oversized-local-model"\n# ${SECRET}\n# ${'界'.repeat(Math.ceil(MAX_BYTES / 3))}\n`);
  const upstream = await createUpstream(t, (_request, response) => jsonResponse(response, {
    data: [{ id: 'Available/API-Model' }],
  }));
  const result = await discoverModels({ ...fixture.options, upstreamOrigin: upstream.upstreamOrigin });
  assert.deepEqual(result.models, [{ id: 'Available/API-Model', displayName: 'Available/API-Model', source: 'api' }]);
  assert.equal(result.currentModel, null);
  assertSafeResult(result, [SECRET, 'oversized-local-model']);
});

test('配置文件读取失败不影响正常 API 目录，结果不包含原始文件错误', async (t) => {
  const fixture = await createFixture(t);
  await fs.mkdir(path.join(fixture.defaultCodexHome, 'config.toml'), { recursive: true });
  const upstream = await createUpstream(t, (_request, response) => jsonResponse(response, { data: [{ id: 'api-model' }] }));
  const result = await discoverModels({ ...fixture.options, upstreamOrigin: upstream.upstreamOrigin });
  assert.deepEqual(result.models, [{ id: 'api-model', displayName: 'api-model', source: 'api' }]);
  assert.equal(result.currentModel, null);
  assertSafeResult(result, [SECRET, 'EISDIR']);
});

test('恰好 1 MiB 的 API 目录和配置文件仍在允许范围内', async (t) => {
  const fixture = await createFixture(t);
  const configPrefix = 'model = "Local/At-Limit"\n# ';
  await fixture.writeConfig(fixture.defaultCodexHome, configPrefix + 'x'.repeat(MAX_BYTES - Buffer.byteLength(configPrefix)));
  const metadata = { data: [{ id: 'API/At-Limit' }], padding: '' };
  metadata.padding = 'x'.repeat(MAX_BYTES - Buffer.byteLength(JSON.stringify(metadata)));
  const payload = JSON.stringify(metadata);
  assert.equal(Buffer.byteLength(payload), MAX_BYTES);
  const upstream = await createUpstream(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(payload);
  });
  const result = await discoverModels({ ...fixture.options, upstreamOrigin: upstream.upstreamOrigin });
  assert.deepEqual(result.models, [{ id: 'API/At-Limit', displayName: 'API/At-Limit', source: 'api' }]);
  assert.equal(result.currentModel, 'Local/At-Limit');
  assertSafeResult(result);
});

test('非回环上游在联网之前被拒绝，仍可回退本机配置', async (t) => {
  const fixture = await createFixture(t);
  await fixture.writeConfig(fixture.defaultCodexHome, 'model = "Local/Only"\n');
  // 在独立模块上下文阻断 HTTP(S)，即便地址校验回归也不会访问外部网络。
  const filename = path.resolve(__dirname, '../local/src/model-discovery.js');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  let networkAttempts = 0;
  const blockedNetwork = () => {
    networkAttempts++;
    throw new Error('测试禁止访问外部网络');
  };
  const source = await fs.readFile(filename, 'utf8');
  const load = vm.runInNewContext(wrap(source), {
    Buffer, URL, setTimeout, clearTimeout, fetch: blockedNetwork,
    process: { env: {} },
  }, { filename });
  load(module.exports, (id) => {
    if (['node:http', 'http', 'node:https', 'https'].includes(id)) {
      return { ...realRequire(id), request: blockedNetwork, get: blockedNetwork };
    }
    return realRequire(id);
  }, module, filename, path.dirname(filename));
  for (const upstreamOrigin of [
    'http://192.0.2.1:2900',
    'https://example.test',
    'http://127.0.0.1.example.test:2900',
  ]) {
    const result = JSON.parse(JSON.stringify(await module.exports.discoverModels({
      ...fixture.options, upstreamOrigin, timeoutMs: 50,
    })));
    assertLocalFallback(result, 'Local/Only');
    assert.ok(result.warnings.length > 0);
  }
  assert.equal(networkAttempts, 0, '非回环地址不得进入任何 HTTP(S) 请求');
});
