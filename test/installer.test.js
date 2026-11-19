'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerRemoteInstaller, compareVersions } = require('../local/src/installer');

function harness(options = {}) {
  const registered = new Map();
  const state = {
    remote: options.remote,
    infos: [], calls: [], installs: [],
    probe: options.probe,
    performInstall: options.performInstall,
    selection: options.selection,
  };
  const context = {
    subscriptions: [],
    extension: { packageJSON: { version: '0.3.0' }, extensionKind: 1 },
    extensionUri: { scheme: 'file', path: '/installed/main-extension' },
  };
  const vscode = {
    ExtensionKind: { UI: 1, Workspace: 2 },
    env: { remoteName: options.remoteName === undefined ? 'ssh-remote' : options.remoteName },
    workspace: { isTrusted: options.trusted !== false },
    Uri: {
      joinPath(uri, ...parts) { return { ...uri, path: uri.path + '/' + parts.join('/') }; },
    },
    window: {
      async showInformationMessage(message, ...actions) {
        state.infos.push({ message, actions });
        if (actions.length) return typeof state.selection === 'function' ? state.selection() : state.selection;
      },
    },
    commands: {
      registerCommand(name, callback) {
        registered.set(name, callback);
        return { dispose() { registered.delete(name); } };
      },
      async getCommands() {
        if (options.listCommands) return options.listCommands();
        return state.remote ? ['codexLocalBridge.remote.version'] : [];
      },
      async executeCommand(name, ...args) {
        state.calls.push({ name, args });
        if (name === 'codexLocalBridge.remote.version') {
          if (state.probe) return state.probe();
          if (!state.remote) throw new Error('Synthetic command-not-found detail');
          return state.remote;
        }
        assert.equal(name, 'workbench.extensions.installExtension');
        state.installs.push(args);
        if (state.performInstall) return state.performInstall();
        state.remote = { version: '0.3.0', kind: 'workspace' };
        return undefined;
      },
    },
  };
  const installer = registerRemoteInstaller(vscode, context, { probeTimeoutMs: 15 });
  return { ...installer, state, context, vscode, registered };
}

const remote = version => ({ version, kind: 'workspace' });

test('单安装入口首次仅提示；取消后不安装，重复检查不再次提示', async () => {
  const h = harness();
  await h.initialCheck;
  assert.equal(h.state.infos.length, 1);
  assert.deepEqual(h.state.infos[0].actions, ['安装远程组件']);
  assert.equal(h.state.installs.length, 0);
  await h.offer();
  assert.equal(h.state.infos.length, 1);
});

test('用户点击后从固定本机扩展 URI 安装内嵌 VSIX，确认同版响应才报告就绪', async () => {
  const h = harness({ selection: '安装远程组件' });
  await h.initialCheck;
  assert.deepEqual(h.state.installs, [[{ scheme: 'file', path: '/installed/main-extension/assets/remote.vsix' }]]);
  assert.ok(h.state.infos.at(-1).message.includes('远程组件已就绪'));
  assert.equal(h.state.calls.filter(call => call.name === 'codexLocalBridge.remote.version').length, 3);
});

test('显式安装命令忽略任意参数，旧组件升级后再探测真实版本', async () => {
  const h = harness({ remote: remote('0.2.0') });
  await h.initialCheck;
  const result = await h.registered.get('codexLocalBridge.installRemote')({ uri: 'https://example.invalid/arbitrary.vsix' });
  assert.equal(result.status, 'ready');
  assert.equal(h.state.installs.length, 1);
  assert.equal(h.state.installs[0].length, 1);
  assert.equal(h.state.installs[0][0].path, '/installed/main-extension/assets/remote.vsix');
});

test('无远程窗口或不受信任工作区均不探测、不安装', async () => {
  for (const options of [{ remoteName: '' }, { trusted: false }]) {
    const h = harness(options);
    await h.initialCheck;
    assert.equal(h.state.infos.length, 0);
    assert.equal((await h.install()).status, 'blocked');
    assert.equal(h.state.calls.length, 0);
    assert.equal(h.state.installs.length, 0);
  }
});

test('信任在确认提示期间撤销时，点击安装仍不执行', async () => {
  const h = harness();
  h.state.selection = () => { h.vscode.workspace.isTrusted = false; return '安装远程组件'; };
  await h.initialCheck;
  assert.equal(h.state.installs.length, 0);
});

test('同版不重复安装；更高版不降级，并提示更新本机主插件', async () => {
  for (const version of ['0.3.0', '0.3.0+build.1', '0.3.1', '1.0.0']) {
    const h = harness({ remote: remote(version) });
    await h.initialCheck;
    assert.equal((await h.install()).status, 'skipped');
    assert.equal(h.state.installs.length, 0);
    if (compareVersions(version, '0.3.0') > 0) assert.ok(h.state.infos.at(-1).message.includes('已保留'));
  }
});

test('无法确认版本或宿主时不覆盖组件，不把未知状态当成缺失', async () => {
  for (const value of [{ version: 'invalid', kind: 'workspace' }, { version: '0.3.0', kind: 'unavailable' }]) {
    const h = harness({ remote: value });
    await h.initialCheck;
    assert.equal((await h.install()).status, 'blocked');
    assert.equal(h.state.installs.length, 0);
  }
  const h = harness({ probe: () => { throw new Error('Synthetic execution failure'); }, listCommands: () => ['codexLocalBridge.remote.version'] });
  await h.initialCheck;
  assert.equal((await h.install()).status, 'blocked');
  assert.equal(h.state.installs.length, 0);
});

test('安装命令返回后未激活新版时，明确要求重载，不误报成功', async () => {
  const h = harness({ remote: remote('0.2.0'), performInstall: async () => ({ installed: true }) });
  await h.initialCheck;
  assert.equal((await h.install()).status, 'reload-required');
  assert.ok(h.state.infos.at(-1).message.includes('尚未确认就绪'));
  assert.ok(h.state.infos.at(-1).message.includes('Developer: Reload Window'));
  assert.equal(h.state.calls.some(call => /reload/i.test(call.name)), false);
});

test('安装失败只返回固定提示，不回显工具错误正文', async () => {
  const synthetic = 'synthetic-install-error-content';
  const h = harness({ performInstall: async () => { throw new Error(synthetic); } });
  await h.initialCheck;
  assert.equal((await h.install()).status, 'failed');
  assert.ok(h.state.infos.at(-1).message.includes('安装未完成'));
  assert.equal(JSON.stringify(h.state.infos).includes(synthetic), false);
});

test('未响应的版本 RPC 有限等待，不安装也不阻塞激活后的检查', { timeout: 1000 }, async () => {
  const h = harness({ probe: () => new Promise(() => {}) });
  await h.initialCheck;
  assert.equal((await h.install()).status, 'blocked');
  assert.equal(h.state.installs.length, 0);
});

test('版本 RPC 拒绝且命令清单不返回时，也有限等待并保持未知状态', { timeout: 1000 }, async () => {
  const h = harness({ listCommands: () => new Promise(() => {}) });
  await h.initialCheck;
  assert.equal((await h.install()).status, 'blocked');
  assert.equal(h.state.installs.length, 0);
});

test('并发运行安装命令复用同一次安装，不重复提交编辑器操作', async () => {
  let finish;
  const h = harness({ performInstall: () => new Promise(resolve => { finish = resolve; }) });
  await h.initialCheck;
  const first = h.install();
  const second = h.install();
  assert.equal(first, second);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.installs.length, 1);
  h.state.remote = remote('0.3.0');
  finish();
  assert.equal((await first).status, 'ready');
  assert.equal((await second).status, 'ready');
});

test('销毁窗口后迟到的探测不会弹出安装提示或开始安装', async () => {
  let rejectProbe;
  const h = harness({ probe: () => new Promise((_, reject) => { rejectProbe = reject; }) });
  await new Promise(resolve => setImmediate(resolve));
  for (const subscription of h.context.subscriptions) subscription.dispose();
  rejectProbe(new Error('Synthetic disconnect'));
  await h.initialCheck;
  assert.equal(h.state.infos.length, 0);
  assert.equal(h.state.installs.length, 0);
});

test('主插件元数据、包 URI 或宿主类型异常时拒绝安装', async () => {
  for (const change of [h => { h.context.extension.packageJSON.version = 'bad'; }, h => { h.context.extension.packageJSON.version = '0.4.0'; }, h => { h.context.extensionUri.scheme = 'vscode-remote'; }, h => { h.context.extension.extensionKind = 2; }]) {
    const h = harness({ trusted: false });
    await h.initialCheck;
    h.vscode.workspace.isTrusted = true;
    change(h);
    assert.equal((await h.install()).status, 'blocked');
    assert.equal(h.state.installs.length, 0);
  }
});

test('SemVer 比较遵循预发布顺序、数字标识长度和构建元数据', () => {
  const sequence = ['0.3.0-alpha', '0.3.0-alpha.1', '0.3.0-alpha.beta', '0.3.0-beta', '0.3.0-beta.2', '0.3.0-beta.11', '0.3.0-rc.1', '0.3.0'];
  for (let index = 1; index < sequence.length; index++) assert.equal(compareVersions(sequence[index - 1], sequence[index]), -1);
  assert.equal(compareVersions('0.3.0+build.2', '0.3.0+build.1'), 0);
  assert.equal(compareVersions('1.0.0-999999999999999999999', '1.0.0-9999999999999999999999'), -1);
  for (const value of ['0.03.0', '0.3.0-01', '0.3', '', null]) assert.equal(compareVersions(value, '0.3.0'), undefined);
});
