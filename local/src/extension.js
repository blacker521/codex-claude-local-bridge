'use strict';

const vscode = require('vscode');
const { LocalBroker } = require('./broker');
const { discoverModels } = require('./model-discovery');
const { resolveLocalAuthentication } = require('./local-auth');

function activate(context) {
  let broker = null;
  let configurationError = null;

  const reload = () => {
    if (broker) broker.dispose();
    broker = null;
    configurationError = null;
    try {
      const upstreamOrigin = vscode.workspace.getConfiguration('codexLocalBridge').get(
        'upstreamOrigin', 'http://127.0.0.1:2900',
      );
      broker = new LocalBroker({ upstreamOrigin });
    } catch (error) {
      configurationError = error.message;
      void vscode.window.showErrorMessage(`Codex Local Bridge 本机配置无效：${configurationError}`);
    }
  };

  const currentBroker = () => {
    if (!broker) throw new Error(configurationError || 'Local broker is not available');
    return broker;
  };

  // Only JSON-serializable arguments/results cross the existing Remote channel.
  const localAuthentication = () => {
    const config = vscode.workspace.getConfiguration('codexLocalBridge');
    return resolveLocalAuthentication({
      codexHome: config.get('codexHome', ''),
      mode: config.get('authentication', 'auto'),
    });
  };
  context.subscriptions.push(vscode.commands.registerCommand('codexLocalBridge.local.begin', async argument => {
    if (argument?.path === '/health') return currentBroker().begin(argument);
    const auth = await localAuthentication();
    return currentBroker().begin(argument, auth.headers);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codexLocalBridge.local.authStatus', async () => {
    const auth = await localAuthentication();
    return { mode: auth.mode };
  }));
  for (const method of ['write', 'end', 'read', 'cancel', 'status']) {
    context.subscriptions.push(vscode.commands.registerCommand(
      `codexLocalBridge.local.${method}`,
      argument => currentBroker()[method](argument),
    ));
  }
  context.subscriptions.push(vscode.commands.registerCommand('codexLocalBridge.local.models', () => {
    const configuration = vscode.workspace.getConfiguration('codexLocalBridge');
    const upstreamOrigin = broker ? broker.upstreamOrigin
      : configuration.get('upstreamOrigin', 'http://127.0.0.1:2900');
    return discoverModels({
      upstreamOrigin,
      codexHome: configuration.get('codexHome', ''),
      ccSwitchHome: configuration.get('ccSwitchHome', ''),
    });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codexLocalBridge.showStatus', () => {
    const status = currentBroker().status();
    return vscode.window.showInformationMessage(
      `Codex Local Bridge：${status.upstreamOrigin}，当前 ${status.activeRequests} 个请求会话，协议 v${status.protocolVersion}。`,
    );
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('codexLocalBridge.upstreamOrigin')) reload();
  }));
  context.subscriptions.push({
    dispose() {
      if (broker) broker.dispose();
      broker = null;
    },
  });
  reload();
}

module.exports = { activate };
