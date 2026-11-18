'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { TextDecoder } = require('node:util');

const managed = () => ({ mode: 'proxy-managed', headers: { authorization: 'Bearer PROXY_MANAGED' } });
const loginError = () => new Error('本机 ChatGPT 登录文件不可用，请在 CC Switch 认证中心激活账号，并确认 codexHome 与它使用的 Codex 目录一致。');

function safeCredential(value, maximum, token = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw loginError();
  }
  const text = value.trim();
  if (token && /\s/.test(value)) throw loginError();
  try { http.validateHeaderValue('authorization', text); } catch { throw loginError(); }
  return text;
}

async function resolveLocalAuthentication({
  codexHome,
  env = process.env,
  homeDirectory,
  mode = 'auto',
} = {}) {
  if (!['auto', 'proxy-managed', 'local-chatgpt'].includes(mode)) throw new Error('本机认证模式无效。');
  if (mode === 'proxy-managed') return managed();
  const home = homeDirectory === undefined ? os.homedir() : homeDirectory;
  const directory = (typeof codexHome === 'string' && codexHome.trim())
    || (typeof env?.CODEX_HOME === 'string' && env.CODEX_HOME.trim())
    || path.join(home, '.codex');
  if (!path.isAbsolute(directory)) throw new Error('本机 Codex 配置目录必须是绝对路径。');
  let file;
  try {
    file = await fs.open(path.join(directory, 'auth.json'), 'r');
    const maximum = 1024 * 1024;
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > maximum) throw loginError();
    let login;
    try { login = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { throw loginError(); }
    if (!login || typeof login !== 'object' || Array.isArray(login)) throw loginError();
    if (login.auth_mode !== undefined && login.auth_mode !== 'chatgpt') {
      if (mode === 'auto') return managed();
      throw loginError();
    }
    if (!login.tokens || !login.tokens.access_token || !login.tokens.account_id) {
      if (mode === 'auto' && login.auth_mode !== 'chatgpt') return managed();
      throw loginError();
    }
    const accessToken = safeCredential(login.tokens.access_token, 16384, true);
    const accountId = safeCredential(login.tokens.account_id, 512);
    if (accessToken.includes('PROXY_MANAGED')) throw loginError();
    return {
      mode: 'local-chatgpt',
      headers: { authorization: `Bearer ${accessToken}`, 'chatgpt-account-id': accountId },
    };
  } catch (error) {
    if (mode === 'auto' && error.code === 'ENOENT') return managed();
    throw loginError();
  } finally {
    if (file) await file.close().catch(() => {});
  }
}

module.exports = { resolveLocalAuthentication };
