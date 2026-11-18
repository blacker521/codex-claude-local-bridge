'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { discoverModels } = require('../local/src/model-discovery');

const runFile = promisify(execFile);
const SECRET = 'sk-fixture-only-history-secret';
const HISTORY_SOURCE = 'cc-switch-history';

// 使用临时 SQLite 文件和回环 HTTP 模拟目录；不接触真实配置、数据库或供应商。
async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-history-model-test-'));
  const homeDirectory = path.join(root, 'home');
  const codexHome = path.join(homeDirectory, '.codex');
  // 同时覆盖 Python argv 和 SQLite URI 的空格、中文及保留字符处理。
  const ccSwitchHome = path.join(root, `CC Switch 中文 # ? ${SECRET}`);
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(ccSwitchHome);
  await fs.writeFile(path.join(codexHome, 'config.toml'), '# fixture config without a root model\n');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    codexHome,
    ccSwitchHome,
    dbPath: path.join(ccSwitchHome, 'cc-switch.db'),
    options: { codexHome, ccSwitchHome, env: {}, homeDirectory },
    async writeConfig(content) {
      await fs.writeFile(path.join(codexHome, 'config.toml'), content, 'utf8');
    },
  };
}

async function createUpstream(t, { status = 200, body = { data: [] } } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    request.resume();
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
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
    assert.deepEqual(requests, [{ method: 'GET', path: '/v1/models' }], '历史发现只能请求模型目录');
  });
  return { upstreamOrigin: `http://127.0.0.1:${server.address().port}` };
}

// providers 故意仅保留筛选所需字段：读取 settings_config 会使查询失败。
// proxy_request_logs 也不含 auth、body 或其他请求正文列。
const SQLITE_FIXTURE = String.raw`
import json
import sqlite3
import sys

data = json.loads(sys.argv[2])
connection = sqlite3.connect(sys.argv[1])
connection.execute('CREATE TABLE providers (id TEXT, app_type TEXT, is_current INTEGER)')
connection.executemany('INSERT INTO providers VALUES (?, ?, ?)', data['providers'])
if data['schema'] != 'missing-logs':
    request_column = '' if data['schema'] == 'legacy' else ', request_model TEXT'
    connection.execute('CREATE TABLE proxy_request_logs ('
                       'id TEXT, provider_id TEXT, app_type TEXT, status_code INTEGER, '
                       'created_at INTEGER, model TEXT' + request_column + ')')
    columns = ['id', 'provider_id', 'app_type', 'status_code', 'created_at', 'model']
    if data['schema'] != 'legacy':
        columns.append('request_model')
    placeholders = ', '.join('?' for _ in columns)
    connection.executemany('INSERT INTO proxy_request_logs VALUES (' + placeholders + ')',
                           [[row.get(column) for column in columns] for row in data['rows']])
connection.commit()
connection.close()
`;

async function createDatabase(fixture, rows = [], {
  providers = [['current-codex', 'codex', 1]], schema = 'current',
} = {}) {
  await runFile('python3', ['-I', '-c', SQLITE_FIXTURE, fixture.dbPath, JSON.stringify({ providers, rows, schema })], {
    timeout: 5000, maxBuffer: 64 * 1024,
  });
}

function record(id, overrides = {}) {
  return {
    id,
    provider_id: 'current-codex',
    app_type: 'codex',
    status_code: 200,
    created_at: 1,
    request_model: 'Vendor/Requested-Model',
    model: 'Vendor/Recorded-Model',
    ...overrides,
  };
}

function assertSafeResult(result) {
  assert.ok(Array.isArray(result.models));
  assert.ok(Array.isArray(result.warnings));
  for (const warning of result.warnings) {
    assert.equal(typeof warning, 'string');
    assert.ok(warning.length <= 300, '警告只能包含简短状态说明');
  }
  assert.equal(JSON.stringify(result).includes(SECRET), false, '不能泄露数据库路径、配置或错误正文');
}

function assertHistoryModel(result, id) {
  assert.deepEqual(result.models, [{ id, displayName: id, source: HISTORY_SOURCE }]);
  assert.equal(result.currentModel, null, '历史观察不代表 config.toml 的当前模型');
  assertSafeResult(result);
}

function assertEmptyResult(result) {
  assert.deepEqual(result.models, []);
  assert.equal(result.currentModel, null);
  assert.ok(result.warnings.length > 0, '不可用时应给出可操作的安全提示');
  assertSafeResult(result);
}

async function createPythonProbe(fixture, source) {
  const executable = path.join(fixture.root, 'python probe # ?');
  const marker = path.join(fixture.root, 'python-probe.called');
  await fs.writeFile(executable, `#!${process.execPath}\n'use strict';\n` +
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n` + source);
  await fs.chmod(executable, 0o700);
  return { executable, marker };
}

test('历史只取当前 Codex 供应商最近的 2xx 请求，忽略其他供应商、应用与失败请求', async (t) => {
  const fixture = await createFixture(t);
  await createDatabase(fixture, [
    record('older-success', { created_at: 10, request_model: 'Vendor/Older-Model' }),
    record('latest-success', { created_at: 20, status_code: 299, request_model: 'Vendor/GPT-MiXeD' }),
    record('other-provider', { created_at: 90, provider_id: 'inactive-codex', request_model: 'wrong-inactive' }),
    record('claude-provider', { created_at: 91, provider_id: 'current-claude', app_type: 'claude', request_model: 'wrong-claude' }),
    record('wrong-app', { created_at: 92, app_type: 'claude', request_model: 'wrong-app' }),
    record('informational', { created_at: 93, status_code: 199, request_model: 'wrong-199' }),
    record('redirect', { created_at: 94, status_code: 300, request_model: 'wrong-300' }),
    record('failure', { created_at: 95, status_code: 500, request_model: 'wrong-500' }),
    record('empty-latest', { created_at: 96, request_model: '   ', model: '' }),
  ], { providers: [
    ['current-codex', 'codex', 1],
    ['inactive-codex', 'codex', 0],
    ['current-claude', 'claude', 1],
  ] });
  const upstream = await createUpstream(t);
  const result = await discoverModels({ ...fixture.options, ...upstream });
  assertHistoryModel(result, 'Vendor/GPT-MiXeD');
});

test('request_model 优先，空值回退 model，并兼容缺少 request_model 的旧 schema', async (t) => {
  const cases = [
    { name: '优先使用原请求 ID', request_model: 'Exact/Request-MODEL', model: 'Other/Alias', expected: 'Exact/Request-MODEL' },
    { name: '空字符串回退', request_model: '', model: 'Exact/Fallback-MODEL', expected: 'Exact/Fallback-MODEL' },
    { name: 'null 回退', request_model: null, model: 'Exact/Null-Fallback', expected: 'Exact/Null-Fallback' },
    { name: '旧 schema 回退', schema: 'legacy', model: 'Exact/Legacy-MODEL', expected: 'Exact/Legacy-MODEL' },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const fixture = await createFixture(t);
      await createDatabase(fixture, [record('success', scenario)], { schema: scenario.schema });
      const upstream = await createUpstream(t);
      assertHistoryModel(await discoverModels({ ...fixture.options, ...upstream }), scenario.expected);
    });
  }
});

test('API 不可用时也能从历史发现模型，错误正文不会进入结果', async (t) => {
  const fixture = await createFixture(t);
  await createDatabase(fixture, [record('success', { request_model: 'Vendor/After-HTTP-Failure' })]);
  const upstream = await createUpstream(t, { status: 503, body: { error: SECRET } });
  assertHistoryModel(await discoverModels({ ...fixture.options, ...upstream }), 'Vendor/After-HTTP-Failure');
});

test('API 有候选或配置有顶层 model 时，不启动历史读取进程', async (t) => {
  for (const scenario of [
    { name: 'API 候选优先', body: { data: [{ id: 'API/Preferred' }] }, config: '# no model\n', id: 'API/Preferred', source: 'api', currentModel: null },
    { name: '配置回退优先', body: { data: [] }, config: 'model = "Config/Preferred"\n', id: 'Config/Preferred', source: 'local-config', currentModel: 'Config/Preferred' },
    { name: 'API 与配置均优先', body: { data: [{ id: 'API/Preferred' }] }, config: 'model = "Config/Current"\n', id: 'API/Preferred', source: 'api', currentModel: 'Config/Current' },
  ]) {
    await t.test(scenario.name, async (t) => {
      const fixture = await createFixture(t);
      await fixture.writeConfig(scenario.config + `api_key = "${SECRET}"\n`);
      await createDatabase(fixture, [record('history', { request_model: 'History/Must-Not-Read' })]);
      const probe = await createPythonProbe(fixture, `process.stdout.write('${JSON.stringify({ model: 'History/Must-Not-Read', status: 'ok' })}');\n`);
      const upstream = await createUpstream(t, { body: scenario.body });
      const result = await discoverModels({ ...fixture.options, ...upstream, pythonExecutable: probe.executable });
      assert.deepEqual(result.models, [{ id: scenario.id, displayName: scenario.id, source: scenario.source }]);
      assert.equal(result.currentModel, scenario.currentModel);
      await assert.rejects(fs.access(probe.marker), { code: 'ENOENT' }, '已有有效来源时不能启动 Python 查询历史');
      assertSafeResult(result);
    });
  }
});

test('数据库不存在、损坏、缺表或历史为空时安全回退，不泄露 fixture secret', async (t) => {
  for (const scenario of ['missing', 'corrupt', 'missing-logs', 'empty', 'no-current-provider', 'no-success']) {
    await t.test(scenario, async (t) => {
      const fixture = await createFixture(t);
      if (scenario === 'corrupt') {
        await fs.writeFile(fixture.dbPath, `not a database ${SECRET}`);
      } else if (scenario !== 'missing') {
        const rows = scenario === 'no-success'
          ? [record('failed', { status_code: 401 })]
          : scenario === 'no-current-provider'
            ? [record('inactive-success', { provider_id: 'old-codex' })] : [];
        await createDatabase(fixture, rows, {
            schema: scenario === 'missing-logs' ? 'missing-logs' : 'current',
            providers: scenario === 'no-current-provider' ? [['old-codex', 'codex', 0]] : undefined,
          });
      }
      const upstream = await createUpstream(t);
      assertEmptyResult(await discoverModels({ ...fixture.options, ...upstream }));
      if (scenario === 'missing') {
        await assert.rejects(fs.access(fixture.dbPath), { code: 'ENOENT' }, '只读发现不能创建不存在的数据库');
      }
    });
  }
});

test('缺少 Python 时返回安全提示，模型发现仍正常完成', async (t) => {
  const fixture = await createFixture(t);
  await createDatabase(fixture, [record('success')]);
  const upstream = await createUpstream(t);
  const result = await discoverModels({
    ...fixture.options,
    ...upstream,
    pythonExecutable: path.join(fixture.root, `missing-python-${SECRET}`),
  });
  assertEmptyResult(result);
  assert.equal(JSON.stringify(result).includes('ENOENT'), false, '不传播原始进程错误');
});

test('历史模型拒绝控制符和超过 200 字符的 ID，保留有效 ID 大小写', async (t) => {
  for (const id of ['Bad\nModel', 'Bad\u0000Model', 'Bad\u007fModel', 'Bad\u0085Model', 'X'.repeat(201), '', null]) {
    await t.test(JSON.stringify(id), async (t) => {
      const fixture = await createFixture(t);
      await createDatabase(fixture, [record('invalid', { request_model: id, model: id })]);
      const upstream = await createUpstream(t);
      assertEmptyResult(await discoverModels({ ...fixture.options, ...upstream }));
    });
  }
  await t.test('200 字符边界允许', async (t) => {
    const fixture = await createFixture(t);
    const id = `Vendor/MiXeD-${'X'.repeat(187)}`;
    assert.equal(id.length, 200);
    await createDatabase(fixture, [record('valid', { request_model: id })]);
    const upstream = await createUpstream(t);
    assertHistoryModel(await discoverModels({ ...fixture.options, ...upstream }), id);
  });
});

test('读取历史不修改数据库或创建辅助文件，且无需供应商配置与请求正文列', async (t) => {
  const fixture = await createFixture(t);
  await createDatabase(fixture, [record('success', { request_model: 'Exact/Read-Only' })]);
  await fs.chmod(fixture.dbPath, 0o444);
  const before = {
    data: await fs.readFile(fixture.dbPath),
    stat: await fs.stat(fixture.dbPath),
    files: await fs.readdir(fixture.ccSwitchHome),
  };
  const upstream = await createUpstream(t);
  assertHistoryModel(await discoverModels({ ...fixture.options, ...upstream }), 'Exact/Read-Only');
  assert.deepEqual(await fs.readFile(fixture.dbPath), before.data);
  assert.equal((await fs.stat(fixture.dbPath)).mtimeMs, before.stat.mtimeMs);
  assert.deepEqual(await fs.readdir(fixture.ccSwitchHome), before.files, '不能留下 journal、WAL 或临时文件');
});

test('Python 的非 JSON 输出或过大输出只能产生安全提示，stderr 不进入发现结果', async (t) => {
  for (const scenario of ['invalid-json', 'oversized']) {
    await t.test(scenario, async (t) => {
      const fixture = await createFixture(t);
      await createDatabase(fixture, [record('success')]);
      const output = scenario === 'invalid-json' ? SECRET : JSON.stringify({
        status: 'ok', model: 'History/Over-Limit-Must-Be-Rejected', padding: 'X'.repeat(64 * 1024),
      });
      const probe = await createPythonProbe(fixture,
        `process.stderr.write(${JSON.stringify(SECRET)});\nprocess.stdout.write(${JSON.stringify(output)});\n`);
      const upstream = await createUpstream(t);
      assertEmptyResult(await discoverModels({ ...fixture.options, ...upstream, pythonExecutable: probe.executable }));
      await fs.access(probe.marker);
    });
  }
});

test('Python 通过独立 argv 收到绝对数据库路径，不受空格和保留字符影响', async (t) => {
  const fixture = await createFixture(t);
  await createDatabase(fixture, [record('success')]);
  const metadata = { model: 'Exact/Argv-Model', status: 'ok' };
  const probe = await createPythonProbe(fixture, `process.stdout.write(${JSON.stringify(JSON.stringify(metadata))});\n`);
  const upstream = await createUpstream(t);
  assertHistoryModel(await discoverModels({ ...fixture.options, ...upstream, pythonExecutable: probe.executable }), metadata.model);
  const args = JSON.parse(await fs.readFile(probe.marker, 'utf8'));
  assert.deepEqual(args, [
    '-I', path.resolve(__dirname, '../local/src/cc-switch-models.py'), fixture.dbPath,
  ]);
  assert.ok(path.isAbsolute(args[2]));
});

test('历史读取进程在 3 秒后被终止，卡住的 Python 不阻塞模型发现', { timeout: 6500 }, async (t) => {
  const fixture = await createFixture(t);
  await createDatabase(fixture, [record('success')]);
  const probe = await createPythonProbe(fixture, `process.stderr.write(${JSON.stringify(SECRET)});\nsetInterval(() => {}, 1000);\n`);
  const upstream = await createUpstream(t);
  const start = performance.now();
  assertEmptyResult(await discoverModels({ ...fixture.options, ...upstream, pythonExecutable: probe.executable }));
  assert.ok(performance.now() - start < 5500, '3 秒子进程超时不应退化为无限等待');
  await fs.access(probe.marker);
});
