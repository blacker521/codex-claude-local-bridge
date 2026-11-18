'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');

const PROVIDER = 'vscode_local_bridge';
const MAX_BYTES = 1024 * 1024;
const unsafe = () => Object.assign(new Error('此配置含复杂、重复或不支持的 TOML 语法，未写入文件。请使用“显示现有 Codex 的配置片段”手动合并。'), { code: 'UNSUPPORTED_TOML' });
const changed = () => new Error('配置文件已被其他操作修改，未覆盖。请重新运行“配置远程 Codex”。');
const authKey = key => /auth|token|secret|credential|headers|api[_-]?key|env_key/i.test(key);

// Deliberately conservative: single-line TOML values and ordinary tables only.
// Unsupported syntax is rejected before any filesystem mutation; original text is never logged.
function parseLine(text) {
  let i = 0;
  const space = () => { while (text[i] === ' ' || text[i] === '\t') i++; };
  function string() {
    const quote = text[i++];
    if (text.slice(i, i + 2) === quote.repeat(2)) throw unsafe();
    let value = '';
    while (i < text.length) {
      const character = text[i++];
      if (character === quote) return value;
      if (character !== '\\' || quote === "'") { value += character; continue; }
      const escape = text[i++];
      const escapes = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
      if (Object.hasOwn(escapes, escape)) { value += escapes[escape]; continue; }
      const size = escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
      const hex = text.slice(i, i + size);
      if (!size || hex.length !== size || !/^[0-9a-f]+$/i.test(hex)) throw unsafe();
      const code = Number.parseInt(hex, 16);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw unsafe();
      value += String.fromCodePoint(code);
      i += size;
    }
    throw unsafe();
  }
  function keys() {
    const result = [];
    for (;;) {
      space();
      if (text[i] === '"' || text[i] === "'") result.push(string());
      else {
        const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
        if (!match) throw unsafe();
        result.push(match[0]);
        i += match[0].length;
      }
      space();
      if (text[i] !== '.') return result;
      i++;
    }
  }
  function value(depth = 0) {
    if (depth > 32) throw unsafe();
    if (text[i] === '"' || text[i] === "'") return { kind: 'string', value: string() };
    if (text[i] === '[') {
      let containsAuth = false;
      i++; space();
      while (text[i] !== ']') {
        containsAuth ||= Boolean(value(depth + 1).containsAuth);
        space();
        if (text[i] === ']') break;
        if (text[i++] !== ',') throw unsafe();
        space();
      }
      i++;
      return { kind: 'array', containsAuth };
    }
    if (text[i] === '{') {
      const tree = new Map();
      let containsAuth = false;
      i++; space();
      while (text[i] !== '}') {
        const key = keys();
        if (text[i++] !== '=') throw unsafe();
        space();
        const nested = value(depth + 1);
        containsAuth = containsAuth || key.some(authKey) || Boolean(nested.containsAuth);
        declareValue(tree, key);
        space();
        if (text[i] === '}') break;
        if (text[i++] !== ',') throw unsafe();
        space();
        if (text[i] === '}') throw unsafe();
      }
      i++;
      return { kind: 'inline', containsAuth };
    }
    const match = /^[^\s,#\]}]+/.exec(text.slice(i));
    if (!match) throw unsafe();
    const atom = match[0];
    const digit = '[0-9](?:_?[0-9])*';
    const integer = '(?:0|[1-9](?:_?[0-9])*)';
    const decimal = new RegExp(`^[+-]?${integer}(?:\\.${digit}(?:[eE][+-]?${digit})?|[eE][+-]?${digit})?$`);
    if (!/^(?:true|false|[+-]?(?:inf|nan)|0x[0-9a-fA-F](?:_?[0-9a-fA-F])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)$/.test(atom) && !decimal.test(atom)) throw unsafe();
    i += atom.length;
    return { kind: 'atom' };
  }
  space();
  if (i === text.length || text[i] === '#') return { type: 'comment' };
  let result;
  if (text[i] === '[') {
    i++;
    const key = keys();
    if (text[i++] !== ']') throw unsafe();
    result = { type: 'table', key };
  } else {
    const key = keys();
    if (text[i++] !== '=') throw unsafe();
    space();
    const prefix = text.slice(0, i);
    const parsedValue = value();
    result = { type: 'value', key, prefix, suffix: text.slice(i), parsedValue };
  }
  space();
  if (i < text.length && text[i] !== '#') throw unsafe();
  return result;
}

function declareValue(tree, keys) {
  for (const [index, key] of keys.entries()) {
    if (index === keys.length - 1) {
      if (tree.has(key)) throw unsafe();
      tree.set(key, { kind: 'value' });
    } else {
      if (!tree.has(key)) tree.set(key, { kind: 'table', dotted: true, children: new Map() });
      const node = tree.get(key);
      if (node.kind !== 'table' || node.explicit) throw unsafe();
      tree = node.children;
    }
  }
}

function declareTable(tree, keys) {
  for (const [index, key] of keys.entries()) {
    if (!tree.has(key)) tree.set(key, { kind: 'table', children: new Map() });
    const node = tree.get(key);
    if (node.kind !== 'table' || node.dotted) throw unsafe();
    if (index === keys.length - 1) {
      if (node.explicit) throw unsafe();
      node.explicit = true;
    }
    tree = node.children;
  }
  return tree;
}

function validateInputs(model, baseUrl) {
  if (typeof model !== 'string' || !model.trim() || model.length > 512 || /[\u0000-\u001f\u007f]/u.test(model) || /[\uD800-\uDFFF]/u.test(model)) {
    throw new Error('模型 ID 无效，请使用供应商提供的单行模型 ID。');
  }
  const match = typeof baseUrl === 'string' && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/v1$/.exec(baseUrl);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error('桥接地址必须是有效的服务器回环 HTTP /v1 地址。');
}

function buildUpdatedConfig(existing, model, baseUrl) {
  validateInputs(model, baseUrl);
  if (typeof existing !== 'string' || Buffer.byteLength(existing) > MAX_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(existing) || /\r(?!\n)/.test(existing)) throw unsafe();
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.match(/[^\n]*\n|[^\n]+$/g) || [];
  const rows = lines.map(raw => {
    const text = raw.replace(/\r?\n$/, '');
    return { raw, text, ...parseLine(text) };
  });
  const root = new Map();
  let table = [], tree = root;
  for (const row of rows) {
    if (row.type === 'table') { table = row.key; tree = declareTable(root, table); }
    if (row.type === 'value') {
      declareValue(tree, row.key);
      const full = [...table, ...row.key];
      // Inline/dotted provider declarations cannot be safely patched without reserializing them.
      if (full[0] === 'model_providers' && (full.length === 1 || full[1] === PROVIDER) && table.length < 2) throw unsafe();
    }
    row.table = table;
  }
  for (const key of ['model', 'model_provider']) if (root.has(key) && root.get(key).kind !== 'value') throw unsafe();
  const profile = rows.find(row => row.type === 'value' && row.table.length === 0 && row.key.length === 1 && row.key[0] === 'profile');
  if (profile) {
    if (profile.parsedValue.kind !== 'string') throw unsafe();
    const overrides = rows.some(row => {
      if (row.type !== 'value') return false;
      const full = [...row.table, ...row.key];
      return full[0] === 'profiles' && (full.length < 3 || (full[1] === profile.parsedValue.value && ['model', 'model_provider'].includes(full[2])));
    });
    if (overrides) throw Object.assign(new Error('当前 profile 可能覆盖顶层模型或 provider，未写入文件。请使用“显示现有 Codex 的配置片段”手动合并到实际使用的 profile。'), { code: 'UNSUPPORTED_TOML' });
  }
  const managed = new Map([
    ['name', '"VS Code Local Bridge"'], ['base_url', JSON.stringify(baseUrl)],
    ['wire_api', '"responses"'], ['requires_openai_auth', 'false'], ['supports_websockets', 'false'],
  ]);
  const providerNode = root.get('model_providers')?.children?.get(PROVIDER);
  for (const key of managed.keys()) if (providerNode?.children?.get(key)?.kind === 'table') throw unsafe();
  const top = new Map([['model', JSON.stringify(model.trim())], ['model_provider', JSON.stringify(PROVIDER)]]);
  const result = [];
  let topInserted = false, providerSeen = false, providerOpen = false;
  const append = text => {
    if (result.length && !result.at(-1).endsWith('\n')) result[result.length - 1] += eol;
    result.push(text + eol);
  };
  function flushTop() {
    if (topInserted) return;
    for (const [key, value] of top) append(`${key} = ${value}`);
    topInserted = true;
  }
  function flushProvider() {
    if (!providerOpen) return;
    for (const [key, value] of managed) append(`${key} = ${value}`);
    providerOpen = false;
  }
  for (const row of rows) {
    const target = row.table[0] === 'model_providers' && row.table[1] === PROVIDER;
    const authTable = target && row.table.slice(2).some(authKey);
    if (row.type === 'table') {
      flushTop(); flushProvider();
      if (target && row.table.length === 2) { providerSeen = true; providerOpen = true; }
      if (authTable) continue;
    }
    if (row.type === 'value') {
      if (authTable) continue;
      const key = row.key[0];
      if (row.table.length === 0 && top.has(key)) {
        if (row.key.length !== 1 || row.parsedValue.kind !== 'string') throw unsafe();
        result.push(row.prefix + top.get(key) + row.suffix + (row.raw.endsWith('\n') ? (row.raw.endsWith('\r\n') ? '\r\n' : '\n') : ''));
        top.delete(key); continue;
      }
      if (target && row.key.some(authKey) && !(row.table.length === 2 && key === 'requires_openai_auth' && row.key.length === 1)) continue;
      if (target && row.table.length === 2) {
        if (managed.has(key)) {
          if (row.key.length !== 1) throw unsafe();
          result.push(row.prefix + managed.get(key) + row.suffix + (row.raw.endsWith('\n') ? (row.raw.endsWith('\r\n') ? '\r\n' : '\n') : ''));
          managed.delete(key); continue;
        }
      }
      // An unknown compound option may contain authentication (for example query_params).
      // Refuse rather than silently retain secrets or delete unrelated nested preferences.
      if (target && row.parsedValue.containsAuth) throw unsafe();
    }
    result.push(row.raw);
  }
  flushTop(); flushProvider();
  if (!providerSeen) {
    append(''); append(`[model_providers.${PROVIDER}]`);
    for (const [key, value] of managed) append(`${key} = ${value}`);
  }
  return result.join('');
}

function resolveConfigPath(env = process.env, home = os.homedir()) {
  const directory = env.CODEX_HOME || path.join(home, '.codex');
  if (!path.isAbsolute(directory) || /[\u0000-\u001f\u007f]/u.test(directory)) throw new Error('远程 CODEX_HOME 必须是绝对路径；请核对远程扩展宿主的环境变量。');
  return path.join(directory, 'config.toml');
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.nlink === b.nlink;
}

async function readConfig(file) {
  let handle;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('配置路径必须是普通文件，自动配置不支持符号链接或硬链接。');
    if (stat.size > MAX_BYTES) throw unsafe();
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!sameFile(stat, await handle.stat())) throw changed();
    const bytes = await handle.readFile();
    if (bytes.length > MAX_BYTES || !sameFile(stat, await handle.stat())) throw changed();
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw unsafe(); }
    return { file, content, stat };
  } catch (error) {
    if (error.code === 'ENOENT') return { file, content: '', stat: undefined };
    throw error;
  } finally { await handle?.close(); }
}

async function assertUnchanged(snapshot) {
  const current = await readConfig(snapshot.file);
  if (Boolean(snapshot.stat) !== Boolean(current.stat) || snapshot.content !== current.content || (snapshot.stat && !sameFile(snapshot.stat, current.stat))) throw changed();
}

async function writePrivate(file, content) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(content, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

async function applyConfig(snapshot, content) {
  if (content === snapshot.content) { await assertUnchanged(snapshot); return { changed: false }; }
  const directory = path.dirname(snapshot.file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('CODEX_HOME 必须是普通目录，自动配置不支持目录符号链接。');
  const lock = path.join(directory, '.codex-local-bridge-config.lock');
  let lockHandle;
  try { lockHandle = await fs.open(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('另一个配置操作正在运行。若上次操作意外中止，请确认后移除 CODEX_HOME/.codex-local-bridge-config.lock 再重试。');
    throw error;
  }
  const temp = path.join(directory, `.codex-local-bridge-${randomUUID()}.tmp`);
  let backup;
  try {
    await assertUnchanged(snapshot);
    if (snapshot.stat) {
      backup = path.join(directory, `config.toml.bridge-backup-${randomUUID()}`);
      await writePrivate(backup, snapshot.content);
    }
    await writePrivate(temp, content);
    await assertUnchanged(snapshot);
    const currentDirectory = await fs.lstat(directory);
    if (currentDirectory.dev !== directoryStat.dev || currentDirectory.ino !== directoryStat.ino || !currentDirectory.isDirectory()) throw changed();
    // Existing files use an atomic replacement. New files use link to avoid clobbering
    // a config created concurrently. A final snapshot check catches external edits.
    if (snapshot.stat) await fs.rename(temp, snapshot.file);
    else {
      try { await fs.link(temp, snapshot.file); }
      catch (error) { if (error.code === 'EEXIST') throw changed(); throw error; }
    }
    return { changed: true, backup };
  } finally {
    await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await lockHandle.close();
    await fs.unlink(lock);
  }
}

module.exports = { PROVIDER, buildUpdatedConfig, resolveConfigPath, readConfig, applyConfig };
