'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { parseOrigin } = require('./broker');

const MAX_METADATA_BYTES = 1024 * 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const WARNINGS = {
  origin: '本机模型接口地址无效，仅支持 HTTP(S) 回环地址。',
  timeout: '本机模型接口请求超时。',
  network: '无法连接本机模型接口。',
  status: '本机模型接口返回非成功状态。',
  size: '本机模型接口响应超过 1 MiB 限制。',
  json: '本机模型接口未返回有效 JSON。',
  empty: '本机模型接口没有可用的模型 id 或 slug。',
  configHome: '本机 Codex 配置目录必须是绝对路径。',
  configMissing: '本机 Codex config.toml 不存在。',
  configRead: '无法读取本机 Codex config.toml。',
  configSize: '本机 Codex config.toml 超过 1 MiB 限制。',
  configSyntax: '无法可靠解析本机配置中的顶层 model 字符串。',
  configEmpty: '本机 Codex 配置没有可用的顶层 model。',
  historyHome: 'CC Switch 数据目录必须是绝对路径。',
  historyMissing: '未找到本机 CC Switch 模型使用记录。',
  historySchema: '本机 CC Switch 记录格式暂不支持模型发现。',
  historyRead: '无法读取本机 CC Switch 的模型使用记录。',
  historyEmpty: 'CC Switch 当前 Codex 供应商没有成功的模型使用记录。',
  historyPython: '读取 CC Switch 模型记录需要本机可用的 Python 3。',
  historyTimeout: '读取 CC Switch 模型记录超时。',
};

// Values returned by this module are metadata only. Never propagate request or
// TOML parser errors: they can contain configuration values or upstream bodies.
function discoveryError(code) {
  const error = new Error(WARNINGS[code]);
  error.discoveryCode = code;
  return error;
}

function modelId(value) {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) return null;
  const id = value.trim();
  return id && id.length <= 200 ? id : null;
}

function apiModels(document) {
  const models = new Map();
  if (!document || typeof document !== 'object') return [];
  const records = [document.data, document.models].filter(Array.isArray).flat();
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    // Human-readable names never become request model IDs.
    const id = modelId(record.id) || modelId(record.slug);
    if (!id || models.has(id)) continue;
    const displayName = modelId(record.display_name) || modelId(record.name) || id;
    models.set(id, { id, displayName, source: 'api' });
  }
  return [...models.values()];
}

function requestModels(upstreamOrigin, timeoutMs) {
  let origin;
  try { origin = parseOrigin(upstreamOrigin); } catch { throw discoveryError('origin'); }
  return new Promise((resolve, reject) => {
    let request;
    let response;
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (response) response.destroy();
        if (request) request.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const transport = origin.protocol === 'https:' ? https : http;
    try {
      request = transport.request(new URL('/v1/models', origin), {
        method: 'GET',
        headers: { accept: 'application/json', authorization: 'Bearer PROXY_MANAGED' },
        agent: false,
      }, incoming => {
        response = incoming;
        incoming.on('error', () => finish(discoveryError('network')));
        incoming.on('aborted', () => finish(discoveryError('network')));
        incoming.on('close', () => {
          if (!incoming.complete) finish(discoveryError('network'));
        });
        if (!incoming.statusCode || incoming.statusCode < 200 || incoming.statusCode >= 300) {
          finish(discoveryError('status'));
          return;
        }
        const chunks = [];
        let length = 0;
        incoming.on('data', chunk => {
          length += chunk.length;
          if (length > MAX_METADATA_BYTES) {
            finish(discoveryError('size'));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          if (settled) return;
          let document;
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length));
            document = JSON.parse(text);
          }
          catch { finish(discoveryError('json')); return; }
          finish(null, apiModels(document));
        });
      });
      request.on('error', () => finish(discoveryError('network')));
      timer = setTimeout(() => finish(discoveryError('timeout')), timeoutMs);
      request.end();
    } catch {
      finish(discoveryError('network'));
    }
  });
}

function syntaxError() { throw discoveryError('configSyntax'); }

// This scanner reads root assignments only. TOML tables never return to the
// root namespace. Strings, multiline strings, comments and nested array/inline
// table values must be skipped before considering another assignment.
function quotedString(text, start) {
  const quote = text[start];
  const multiline = text.slice(start, start + 3) === quote.repeat(3);
  const prefix = multiline ? 3 : 1;
  let offset = start + prefix;
  while (offset < text.length) {
    const char = text[offset];
    if (char === quote) {
      if (!multiline) return { end: offset + 1, multiline };
      let count = 1;
      while (text[offset + count] === quote) count++;
      if (count >= 3) {
        if (count > 5) syntaxError();
        return { end: offset + count, multiline };
      }
      offset += count;
      continue;
    }
    if (!multiline && (char === '\n' || char === '\r')) syntaxError();
    if (quote === '"' && char === '\\') offset++;
    offset++;
  }
  syntaxError();
}

function basicString(text) {
  let output = '';
  const escapes = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== '\\') {
      if ((char.charCodeAt(0) < 32 && char !== '\t') || char.charCodeAt(0) === 127) syntaxError();
      output += char;
      continue;
    }
    const escaped = text[++index];
    if (Object.prototype.hasOwnProperty.call(escapes, escaped)) {
      output += escapes[escaped];
      continue;
    }
    const digits = escaped === 'u' ? 4 : escaped === 'U' ? 8 : 0;
    const hex = text.slice(index + 1, index + 1 + digits);
    if (!digits || hex.length !== digits || !/^[0-9a-f]+$/i.test(hex)) syntaxError();
    const codePoint = Number.parseInt(hex, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) syntaxError();
    output += String.fromCodePoint(codePoint);
    index += digits;
  }
  return output;
}

function scalarString(text) {
  const quote = text[0];
  if (quote !== '"' && quote !== "'") syntaxError();
  const { end, multiline } = quotedString(text, 0);
  // A multiline model value is unusual; refuse it instead of guessing how
  // TOML continuation/indentation rules change the actual model identifier.
  if (multiline || end !== text.length) syntaxError();
  const inner = text.slice(1, -1);
  if (quote === '"') return basicString(inner);
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(inner)) syntaxError();
  return inner;
}

function assignmentKey(text) {
  const parts = [];
  let offset = 0;
  while (offset < text.length) {
    while (/[ \t]/.test(text[offset] || '') && offset < text.length) offset++;
    const start = offset;
    if (text[offset] === '"' || text[offset] === "'") {
      const { end, multiline } = quotedString(text, offset);
      if (multiline) syntaxError();
      parts.push(scalarString(text.slice(offset, end)));
      offset = end;
    } else {
      while (/[A-Za-z0-9_-]/.test(text[offset] || '') && offset < text.length) offset++;
      if (offset === start) syntaxError();
      parts.push(text.slice(start, offset));
    }
    while (/[ \t]/.test(text[offset] || '') && offset < text.length) offset++;
    if (offset === text.length) break;
    if (text[offset++] !== '.') syntaxError();
    if (offset === text.length) syntaxError();
  }
  if (!parts.length) syntaxError();
  return parts;
}

function topLevelModel(text) {
  let offset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let currentModel = null;
  let seenModel = false;
  while (offset < text.length) {
    // Whitespace and whole-line comments between assignments.
    while (offset < text.length) {
      if (/[ \t\r\n]/.test(text[offset])) { offset++; continue; }
      if (text[offset] === '#') {
        const next = text.indexOf('\n', offset);
        offset = next < 0 ? text.length : next + 1;
        continue;
      }
      break;
    }
    if (offset === text.length || text[offset] === '[') break;
    const keyStart = offset;
    while (offset < text.length && text[offset] !== '=') {
      if (text[offset] === '"' || text[offset] === "'") {
        const quoted = quotedString(text, offset);
        if (quoted.multiline) syntaxError();
        offset = quoted.end;
      } else {
        if (/[#\r\n]/.test(text[offset])) syntaxError();
        offset++;
      }
    }
    if (text[offset] !== '=') syntaxError();
    const key = assignmentKey(text.slice(keyStart, offset).trim());
    const valueStart = ++offset;
    const brackets = [];
    while (offset < text.length) {
      const char = text[offset];
      if (char === '"' || char === "'") {
        offset = quotedString(text, offset).end;
        continue;
      }
      if (char === '#') {
        if (!brackets.length) break;
        const next = text.indexOf('\n', offset);
        offset = next < 0 ? text.length : next + 1;
        continue;
      }
      if (char === '\n' && !brackets.length) break;
      if (char === '[' || char === '{') brackets.push(char);
      else if (char === ']' || char === '}') {
        if (brackets.pop() !== (char === ']' ? '[' : '{')) syntaxError();
      }
      offset++;
    }
    if (brackets.length) syntaxError();
    const value = text.slice(valueStart, offset).trim();
    if (!value) syntaxError();
    if (key[0] === 'model') {
      // A root model table/dotted key cannot also be a scalar model setting.
      if (key.length !== 1 || seenModel) syntaxError();
      seenModel = true;
      currentModel = modelId(scalarString(value));
      if (!currentModel) syntaxError();
    }
  }
  return currentModel;
}

async function configuredModel({ codexHome, env, homeDirectory }) {
  let file;
  try {
    const home = homeDirectory === undefined ? os.homedir() : homeDirectory;
    const configured = typeof codexHome === 'string' ? codexHome.trim() : '';
    const environmentHome = env && typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
    const directory = configured || environmentHome || path.join(home, '.codex');
    if (!path.isAbsolute(directory)) throw discoveryError('configHome');
    file = await fs.open(path.join(directory, 'config.toml'), 'r');
    const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_METADATA_BYTES) throw discoveryError('configSize');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { throw discoveryError('configSyntax'); }
    const currentModel = topLevelModel(text);
    if (!currentModel) throw discoveryError('configEmpty');
    return currentModel;
  } catch (error) {
    if (error.discoveryCode) throw error;
    throw discoveryError(error.code === 'ENOENT' ? 'configMissing' : 'configRead');
  } finally {
    if (file) await file.close().catch(() => {});
  }
}

function historicalModel({ ccSwitchHome, homeDirectory, pythonExecutable }) {
  const home = homeDirectory === undefined ? os.homedir() : homeDirectory;
  const directory = (typeof ccSwitchHome === 'string' && ccSwitchHome.trim()) || path.join(home, '.cc-switch');
  if (!path.isAbsolute(directory)) throw discoveryError('historyHome');
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let child;
    let size = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (child && child.exitCode === null) child.kill('SIGKILL');
        reject(error);
      } else resolve(value);
    };
    try {
      child = spawn(pythonExecutable, [
        '-I', path.join(__dirname, 'cc-switch-models.py'), path.join(directory, 'cc-switch.db'),
      ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      child.once('error', () => finish(discoveryError('historyPython')));
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) { finish(discoveryError('historyRead')); return; }
        chunks.push(chunk);
      });
      child.once('close', code => {
        if (settled) return;
        if (code !== 0) { finish(discoveryError('historyRead')); return; }
        let metadata;
        try { metadata = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
        catch { finish(discoveryError('historyRead')); return; }
        const id = modelId(metadata?.model);
        if (metadata?.status === 'ok' && id) { finish(null, id); return; }
        const reasons = { missing: 'historyMissing', schema: 'historySchema', empty: 'historyEmpty' };
        finish(discoveryError(reasons[metadata?.status] || 'historyRead'));
      });
      timer = setTimeout(() => finish(discoveryError('historyTimeout')), 3000);
    } catch { finish(discoveryError('historyPython')); }
  });
}

async function discoverModels({
  upstreamOrigin = 'http://127.0.0.1:2900',
  codexHome,
  env = process.env,
  homeDirectory,
  ccSwitchHome,
  pythonExecutable = 'python3',
  timeoutMs = 8000,
} = {}) {
  const warnings = [];
  let models = [];
  let currentModel = null;
  const boundedTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, 30000) : 8000;
  try {
    models = await requestModels(upstreamOrigin, boundedTimeout);
    if (!models.length) warnings.push(WARNINGS.empty);
  } catch (error) {
    warnings.push(WARNINGS[error.discoveryCode] || WARNINGS.network);
  }
  try {
    currentModel = await configuredModel({ codexHome, env, homeDirectory });
    if (!models.length) {
      models.push({ id: currentModel, displayName: currentModel, source: 'local-config' });
    }
  } catch (error) {
    // An API result is useful even when no local Codex config is present.
    if (!models.length) warnings.push(WARNINGS[error.discoveryCode] || WARNINGS.configRead);
  }
  if (!models.length) {
    try {
      const id = await historicalModel({ ccSwitchHome, homeDirectory, pythonExecutable });
      models.push({ id, displayName: id, source: 'cc-switch-history' });
    } catch (error) {
      warnings.push(WARNINGS[error.discoveryCode] || WARNINGS.historyRead);
    }
  }
  return { models, currentModel, warnings };
}

module.exports = { discoverModels };
