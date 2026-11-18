'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  buildUpdatedConfig, resolveConfigPath, readConfig, applyConfig,
} = require('../remote/src/configure');

const baseUrl = 'http://127.0.0.1:35721/v1';
const update = text => buildUpdatedConfig(text, 'provider/coder:v2', baseUrl);

async function fixture(t, content) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'codex-home', 'config.toml');
  if (content !== undefined) {
    await fs.mkdir(path.dirname(file), { mode: 0o700 });
    await fs.writeFile(file, content, { mode: 0o600 });
  }
  return { directory, file };
}

function assertBridge(text) {
  assert.match(text, /^model = "provider\/coder:v2"$/m);
  assert.match(text, /^model_provider = "vscode_local_bridge"$/m);
  assert.match(text, /^base_url = "http:\/\/127\.0\.0\.1:35721\/v1"$/m);
  assert.match(text, /^requires_openai_auth = false$/m);
  assert.match(text, /^supports_websockets = false$/m);
}

test('新配置可直接使用；重复生成保持完全相同', () => {
  const content = update('');
  assertBridge(content);
  assert.equal(update(content), content);
  assert.doesNotMatch(content, /api_key|experimental_bearer_token|env_key|http_headers/);
});

test('只替换顶层字段，保留原缩进、注释和其他 provider 原文', () => {
  const other = '[model_providers.custom]\nname = "用户供应商"\nbase_url = "https://api.example.invalid/v1"\nenv_key = "EXAMPLE_KEY"\n';
  const before = '# 用户配置\n  model = "old" # 保留模型注释\nmodel_provider=\'old\'\nmodel_reasoning_effort = "high"\n\n' + other;
  const after = update(before);
  assert.ok(after.startsWith('# 用户配置\n  model = "provider/coder:v2" # 保留模型注释\nmodel_provider="vscode_local_bridge"\nmodel_reasoning_effort = "high"\n\n'));
  assert.ok(after.includes(other));
  assert.equal(update(after), after);
});

test('缺失的顶层字段放在首个表之前；子表中的 model 保持不变', () => {
  const original = '# 自定义\n[profiles.user]\nmodel = "profile-model"\n';
  const after = update(original);
  assertBridge(after);
  assert.ok(after.indexOf('model_provider = ') < after.indexOf('[profiles.user]'));
  assert.ok(after.includes('[profiles.user]\nmodel = "profile-model"\n'));
});

test('原配置有引号键和表名时，正确识别同一 provider 并清除旧认证子表', () => {
  const before = [
    '"model" = "old" # 模型', "'model_provider' = 'old'", '',
    `["model_providers" . 'vscode_local_bridge'] # provider 注释`,
    'name = "旧名称"', 'base_url = "http://127.0.0.1:1/v1" # 地址注释',
    'wire_api = "responses"', 'requires_openai_auth = true', 'supports_websockets = true',
    'request_max_retries = 3', '"experimental_bearer_token" = "FAKE_OLD_VALUE"',
    'env_key = "EXAMPLE_TOKEN"', 'credential = { token = "FAKE_INLINE" }',
    'Authorization = "FAKE_HEADER"',
    'env_http_headers.Authorization = "EXAMPLE_HEADER"',
    '[model_providers.vscode_local_bridge.http_headers]',
    'Authorization = "FAKE_SUBTABLE"', '# 保留注释',
    '[model_providers.vscode_local_bridge.auth.extra]', 'token = "FAKE_NESTED"',
    '[model_providers.other]', 'env_key = "EXAMPLE_OTHER"', '',
  ].join('\n');
  const after = update(before);
  assert.ok(after.includes('"model" = "provider/coder:v2" # 模型'));
  assert.ok(after.includes("'model_provider' = \"vscode_local_bridge\""));
  assert.ok(after.includes('request_max_retries = 3'));
  assert.ok(after.includes('# provider 注释'));
  assert.ok(after.includes('# 地址注释'));
  assert.ok(after.includes('# 保留注释'));
  assert.ok(after.includes('[model_providers.other]\nenv_key = "EXAMPLE_OTHER"\n'));
  assert.doesNotMatch(after, /FAKE_|EXAMPLE_TOKEN|EXAMPLE_HEADER|\.auth|\.http_headers/);
  assert.equal(update(after), after);
});

test('CRLF、新增字段和无末尾换行的配置正确处理', () => {
  const after = update('model="old"\r\n[projects."/tmp/example"]\r\ntrust_level = "trusted"');
  assert.ok(after.includes('model="provider/coder:v2"\r\nmodel_provider = "vscode_local_bridge"\r\n'));
  assert.equal(after.replaceAll('\r\n', '').includes('\n'), false);
  assert.ok(after.includes('trust_level = "trusted"\r\n'));
});

test('字符串中的表头、井号和转义不会变成真实表或注释', () => {
  const before = 'note = "[model_providers.vscode_local_bridge] # \\\"quoted\\\""\noptions = [{ key = "value" }, 1_000, true, ["x", "y",]]\n';
  assert.ok(update(before).startsWith(before));
});

for (const [name, original] of [
  ['重复顶层键', 'model = "a"\n"model" = "b"\n'],
  ['重复目标表', '[model_providers.vscode_local_bridge]\n[model_providers."vscode_local_bridge"]\n'],
  ['重复目标键', '[model_providers.vscode_local_bridge]\nname="a"\nname="b"\n'],
  ['重复无关键', '[other]\nname="a"\nname="b"\n'],
  ['根字段为表', '[model]\nname="a"\n'],
  ['目标 inline table', 'model_providers.vscode_local_bridge = { name = "x" }\n'],
  ['providers inline table', 'model_providers = { other = { name = "x" } }\n'],
  ['目标 dotted key', '[model_providers]\nvscode_local_bridge.name = "x"\n'],
  ['多行字符串', 'instructions = """\n[model_providers.vscode_local_bridge]\n"""\n'],
  ['多行 literal 字符串', "instructions = '''\nmodel = 'fake'\n'''\n"],
  ['多行数组', 'items = [\n"value"\n]\n'],
  ['array-of-tables', '[[skills.config]]\npath="example"\n'],
  ['裸文本', 'model = invalid\n'],
  ['无效 escape', 'note = "bad\\q"\n'],
  ['无效 unicode', 'note = "bad\\uD800"\n'],
  ['未闭合字符串', 'note = "unterminated\n'],
  ['不完整表头', '[model_providers.vscode_local_bridge\n'],
  ['错误顶层 model 类型', 'model = true\n'],
  ['目标字段为 dotted table', '[model_providers.vscode_local_bridge]\nbase_url.child = "wrong"\n'],
  ['inline table 重复键', 'options = { a = 1, a = 2 }\n'],
  ['inline table 尾逗号', 'options = { a = 1, }\n'],
  ['尾随无效文本', 'name = "x" unexpected\n'],
]) {
  test(`自动配置拒绝${name}，错误不回显原配置`, () => {
    assert.throws(() => update(original), error => {
      assert.match(error.message, /未写入文件/);
      assert.doesNotMatch(error.message, /fake|unterminated|invalid|unexpected/);
      return true;
    });
  });
}

test('拒绝模型控制字符和非回环或含认证信息的地址', () => {
  for (const model of ['', '\nmodel', 'valid\u0000', '\ud800', 'a'.repeat(513)]) assert.throws(() => buildUpdatedConfig('', model, baseUrl));
  for (const address of ['https://api.example.invalid/v1', 'http://127.0.0.1:0/v1', 'http://127.0.0.1:65536/v1', 'http://user:FAKE@127.0.0.1:35721/v1', baseUrl + '?key=FAKE', 'http://127.0.0.2:35721/v1']) {
    assert.throws(() => buildUpdatedConfig('', 'model', address), /服务器回环/);
  }
  assert.match(buildUpdatedConfig('', '模型/😀', 'http://[::1]:1234/v1'), /模型\/😀/);
});

test('路径仅由显式环境和用户目录解析，不依赖工作区', () => {
  const home = path.join(os.tmpdir(), 'fixture-user');
  assert.equal(resolveConfigPath({}, home), path.join(home, '.codex', 'config.toml'));
  assert.equal(resolveConfigPath({ CODEX_HOME: path.join(home, 'custom') }, home), path.join(home, 'custom', 'config.toml'));
  assert.throws(() => resolveConfigPath({ CODEX_HOME: 'relative' }, home), /绝对路径/);
});

test('不存在的目录/配置安全新建，权限 0700/0600；不产生备份或残留临时文件', async t => {
  const { file } = await fixture(t);
  const snapshot = await readConfig(file);
  const result = await applyConfig(snapshot, update(snapshot.content));
  assert.equal(result.changed, true);
  assert.equal(result.backup, undefined);
  assertBridge(await fs.readFile(file, 'utf8'));
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['config.toml']);
});

test('更新原文件前保存逐字备份，备份与新文件均为0600，其他文件不变', async t => {
  const original = 'model="old"\n# user config\n';
  const { file } = await fixture(t, original);
  const auth = path.join(path.dirname(file), 'auth.json');
  await fs.writeFile(auth, '{"fixture":"FAKE_TEST_ONLY"}');
  await fs.chmod(file, 0o644);
  const snapshot = await readConfig(file);
  const result = await applyConfig(snapshot, update(original));
  assert.equal(result.changed, true);
  assert.equal(await fs.readFile(result.backup, 'utf8'), original);
  assert.equal((await fs.stat(result.backup)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(auth, 'utf8'), '{"fixture":"FAKE_TEST_ONLY"}');
  assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ['auth.json', 'config.toml', path.basename(result.backup)].sort());
});

test('匹配配置无需备份或重写', async t => {
  const original = update('');
  const { file } = await fixture(t, original);
  const snapshot = await readConfig(file);
  const result = await applyConfig(snapshot, update(original));
  assert.deepEqual(result, { changed: false });
  assert.equal((await fs.stat(file)).ino, snapshot.stat.ino);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['config.toml']);
});

for (const mutation of ['edit', 'delete', 'replace-same-content', 'new-file']) {
  test(`确认期间发生外部变更 ${mutation} 时拒绝覆盖`, async t => {
    const { file } = await fixture(t, mutation === 'new-file' ? undefined : 'model="old"\n');
    const snapshot = await readConfig(file);
    if (mutation === 'edit') await fs.writeFile(file, 'model="external"\n');
    if (mutation === 'delete') await fs.unlink(file);
    if (mutation === 'replace-same-content') { await fs.unlink(file); await fs.writeFile(file, snapshot.content); }
    if (mutation === 'new-file') { await fs.mkdir(path.dirname(file)); await fs.writeFile(file, 'model="new-external"\n'); }
    await assert.rejects(applyConfig(snapshot, update(snapshot.content)), /未覆盖/);
    if (mutation === 'delete') await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(file, 'utf8'), mutation === 'edit' ? 'model="external"\n' : mutation === 'new-file' ? 'model="new-external"\n' : snapshot.content);
    assert.equal((await fs.readdir(path.dirname(file))).some(name => name.includes('bridge')), false);
  });
}

test('拒绝符号链接、硬链接及并行配置锁', async t => {
  const { directory, file } = await fixture(t, 'model="old"\n');
  const link = path.join(directory, 'linked.toml');
  await fs.symlink(file, link);
  await assert.rejects(readConfig(link), /普通文件/);
  await fs.unlink(link);
  await fs.link(file, link);
  await assert.rejects(readConfig(file), /普通文件/);
  await fs.unlink(link);
  const snapshot = await readConfig(file);
  const lock = path.join(path.dirname(file), '.codex-local-bridge-config.lock');
  await fs.writeFile(lock, '');
  await assert.rejects(applyConfig(snapshot, update(snapshot.content)), /另一个配置操作/);
  assert.equal(await fs.readFile(file, 'utf8'), snapshot.content);
});

test('拒绝目录符号链接、非法UTF-8和超限配置', async t => {
  const { directory, file } = await fixture(t, 'model="old"\n');
  const alias = path.join(directory, 'alias');
  await fs.symlink(path.dirname(file), alias);
  const snapshot = await readConfig(path.join(alias, 'config.toml'));
  await assert.rejects(applyConfig(snapshot, update(snapshot.content)), /普通目录/);
  await fs.writeFile(file, Buffer.from([0xff]));
  await assert.rejects(readConfig(file), /未写入文件/);
  await fs.writeFile(file, Buffer.alloc(1024 * 1024 + 1, 32));
  await assert.rejects(readConfig(file), /未写入文件/);
});

for (const content of [
  'profile="selected"\n[profiles.selected]\nmodel="override"\n',
  'profile="selected"\n[profiles]\nselected.model_provider="override"\n',
  'profile="selected"\nprofiles = { selected = { model = "override" } }\n',
]) {
  test('实际启用的 profile 覆盖模型或 provider 时拒绝误报顶层配置已生效', () => {
    assert.throws(() => update(content), /当前 profile 可能覆盖/);
  });
}

test('profile 中只有无关偏好时可继续配置', () => {
  const original = 'profile="selected"\n[profiles.selected]\nmodel_reasoning_effort="high"\n';
  assert.ok(update(original).includes('[profiles.selected]\nmodel_reasoning_effort="high"\n'));
});

test('BOM 不会在备份前悄悄丢失，带 BOM 配置走保守手动流程', async t => {
  const original = '\ufeffmodel="old"\n';
  const { file } = await fixture(t, original);
  const snapshot = await readConfig(file);
  assert.equal(snapshot.content, original);
  assert.throws(() => update(snapshot.content), /未写入文件/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

for (const field of ['name', 'base_url', 'wire_api', 'requires_openai_auth', 'supports_websockets']) {
  test(`managed 字段 ${field} 已声明为子表时拒绝生成冲突键`, () => {
    assert.throws(() => update(`[model_providers.vscode_local_bridge.${field}]\nx="fixture"\n`), /未写入文件/);
  });
}

for (const original of ['[a.b]\n[a]\nb.c=1\n', '[a.b.c]\n[a]\nb.c.d=1\n']) {
  test('dotted key 不得重新进入已显式声明的表命名空间', () => {
    assert.throws(() => update(original), /未写入文件/);
  });
}

test('dotted key 可以补充隐式父表，保留合法 TOML', () => {
  const original = '[a.b.c]\n[a]\nb.d=1\n';
  assert.ok(update(original).includes(original));
});

test('目标 provider 的未知 dotted 选项也清理嵌套 auth 键', () => {
  const original = '[model_providers.vscode_local_bridge]\ncustom.env_key="EXAMPLE_ONLY"\nquery_params.api_key="FAKE_ONLY"\nrequest_max_retries=3\n';
  const after = update(original);
  assert.doesNotMatch(after, /EXAMPLE_ONLY|FAKE_ONLY|env_key|api_key/);
  assert.match(after, /request_max_retries=3/);
});

for (const value of ['{ api_key = "FAKE_ONLY", region = "example" }', '[{ nested = { access_token = "FAKE_ONLY" } }]']) {
  test('未知复合配置内含认证键时拒绝保存，不误删其他嵌套偏好', () => {
    assert.throws(() => update(`[model_providers.vscode_local_bridge]\nquery_params=${value}\n`), /未写入文件/);
  });
}
