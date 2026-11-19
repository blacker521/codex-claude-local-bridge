'use strict';

const VERSION_COMMAND = 'codexLocalBridge.remote.version';
const INSTALL_COMMAND = 'codexLocalBridge.installRemote';

function versionParts(value) {
  if (typeof value !== 'string' || value.length > 128) return undefined;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value);
  if (!match) return undefined;
  const core = match.slice(1, 4).map(Number);
  const pre = match[4]?.split('.') || [];
  if (core.some(value => !Number.isSafeInteger(value)) || pre.some(value => /^\d+$/.test(value) && value.length > 1 && value[0] === '0')) return undefined;
  return { core, pre };
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    if (a.pre[index] === undefined) return -1;
    if (b.pre[index] === undefined) return 1;
    if (a.pre[index] === b.pre[index]) continue;
    const aNumeric = /^\d+$/.test(a.pre[index]);
    const bNumeric = /^\d+$/.test(b.pre[index]);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (aNumeric && a.pre[index].length !== b.pre[index].length) return a.pre[index].length < b.pre[index].length ? -1 : 1;
    return a.pre[index] < b.pre[index] ? -1 : 1;
  }
  return 0;
}

function registerRemoteInstaller(vscode, context, { probeTimeoutMs = 3000 } = {}) {
  const version = context.extension?.packageJSON?.version;
  let disposed = false;
  let offered = false;
  let installing;
  const notify = message => disposed ? undefined : vscode.window.showInformationMessage(message);
  const allowed = () => !disposed && Boolean(vscode.env.remoteName) && vscode.workspace.isTrusted === true;
  const validInstallation = () => Boolean(versionParts(version))
    && context.extension?.packageJSON?.version === version
    && context.extensionUri?.scheme === 'file'
    && context.extension?.extensionKind === vscode.ExtensionKind?.UI;

  async function bounded(operation) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Probe timed out'), { code: 'PROBE_TIMEOUT' })), probeTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async function probe() {
    try {
      const result = await bounded(() => vscode.commands.executeCommand(VERSION_COMMAND));
      if (result?.kind !== 'workspace' || compareVersions(result.version, version) === undefined) return { state: 'unavailable' };
      return { state: 'available', version: result.version };
    } catch (error) {
      if (error?.code === 'PROBE_TIMEOUT') return { state: 'unavailable' };
      try {
        const commands = await bounded(() => vscode.commands.getCommands(true));
        // An existing but failing command is not permission to overwrite an
        // unknown version. Older helpers do not have this command at all.
        if (Array.isArray(commands) && !commands.includes(VERSION_COMMAND)) return { state: 'missing' };
      } catch { /* Keep a safe, unknown state on a disconnected command bus. */ }
      return { state: 'unavailable' };
    }
  }

  function reportCurrent(remote) {
    const comparison = compareVersions(remote.version, version);
    if (comparison === 0) return notify('远程组件已匹配当前主插件版本，无需重复安装。');
    if (comparison > 0) return notify('远程组件版本高于当前主插件，已保留。请更新本机主插件以保持两端版本一致。');
  }

  async function performInstall() {
    if (!vscode.env.remoteName) {
      await notify('请先通过 Remote-SSH 打开目标服务器目录，再运行“安装或更新远程组件”。');
      return { status: 'blocked' };
    }
    if (!allowed()) {
      await notify('请在受信任的远程工作区运行“安装或更新远程组件”。');
      return { status: 'blocked' };
    }
    if (!validInstallation()) {
      await notify('主插件安装信息不可用，请重新安装完整的 Codex Local Bridge VSIX。');
      return { status: 'blocked' };
    }
    const before = await probe();
    if (!allowed() || !validInstallation()) return { status: 'blocked' };
    if (before.state === 'available' && compareVersions(before.version, version) >= 0) {
      await reportCurrent(before);
      return { status: 'skipped' };
    }
    if (before.state === 'unavailable') {
      await notify('暂时无法确认远程组件版本，未进行安装。请运行 Developer: Reload Window 后重试。');
      return { status: 'blocked' };
    }
    try {
      // Only the helper bundled with this installed UI extension is accepted.
      // VS Code chooses the remote host from its workspace extension manifest.
      const uri = vscode.Uri.joinPath(context.extensionUri, 'assets', 'remote.vsix');
      await vscode.commands.executeCommand('workbench.extensions.installExtension', uri);
    } catch {
      await notify('远程组件安装未完成。请确认远程连接正常，并重新运行“安装或更新远程组件”；必要时按 README 手动安装。');
      return { status: 'failed' };
    }
    if (!allowed()) return { status: 'reload-required' };
    const after = await probe();
    if (after.state === 'available' && compareVersions(after.version, version) === 0) {
      await notify('远程组件已就绪。请运行“检查本机出口”，再按需配置远程 Codex。');
      return { status: 'ready' };
    }
    if (after.state === 'available' && compareVersions(after.version, version) > 0) {
      await reportCurrent(after);
      return { status: 'skipped' };
    }
    await notify('安装命令已完成，远程组件尚未确认就绪。请运行 Developer: Reload Window 后检查本机出口。');
    return { status: 'reload-required' };
  }

  function install() {
    if (!installing) installing = performInstall().finally(() => { installing = undefined; });
    return installing;
  }

  async function offer() {
    if (offered || !allowed() || !versionParts(version)) return;
    offered = true;
    const remote = await probe();
    if (!allowed() || installing) return;
    if (remote.state === 'unavailable') return;
    if (remote.state === 'available' && compareVersions(remote.version, version) >= 0) {
      if (compareVersions(remote.version, version) > 0) await reportCurrent(remote);
      return;
    }
    const action = await vscode.window.showInformationMessage(
      'Codex Local Bridge 已内置远程组件，可通过当前编辑器连接安装到此远程环境。',
      '安装远程组件',
    );
    if (action === '安装远程组件' && allowed()) return install();
  }

  context.subscriptions.push(vscode.commands.registerCommand(INSTALL_COMMAND, () => install()));
  context.subscriptions.push({ dispose() { disposed = true; } });
  // Activation and normal model forwarding never wait for the installer.
  const initialCheck = Promise.resolve().then(offer).catch(() => {});
  return { install, offer, initialCheck };
}

module.exports = { registerRemoteInstaller, compareVersions };
