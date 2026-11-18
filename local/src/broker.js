'use strict';

const http = require('node:http');
const https = require('node:https');
const { randomUUID } = require('node:crypto');

const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_SESSIONS = 8;
const ALLOWED_ROUTES = new Set([
  'GET /health',
  'GET /v1/models',
  'POST /v1/responses',
  'POST /v1/responses/compact',
]);
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseOrigin(value) {
  // Validate before URL parsing: URL normalization must not accept /../ or userinfo.
  if (typeof value !== 'string' ||
      !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(value)) {
    throw new Error('upstreamOrigin must be an HTTP(S) loopback origin with no path');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid upstreamOrigin');
  }
  return url;
}

function filterHeaders(headers, request) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('headers must be an object');
  }
  const blocked = new Set(HOP_HEADERS);
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'connection') {
      for (const token of String(value).split(',')) blocked.add(token.trim().toLowerCase());
    }
  }
  if (request) {
    for (const name of ['authorization', 'chatgpt-account-id', 'host', 'content-length', 'expect']) blocked.add(name);
  }
  const output = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (blocked.has(normalized) || value === undefined) continue;
    if (typeof value !== 'string' &&
        !(Array.isArray(value) && value.every(item => typeof item === 'string'))) {
      throw new Error('Invalid HTTP header value');
    }
    try {
      http.validateHeaderName(normalized);
      for (const item of Array.isArray(value) ? value : [value]) {
        http.validateHeaderValue(normalized, item);
      }
    } catch {
      // Do not include a caller-supplied value in an error or log.
      throw new Error('Invalid HTTP header');
    }
    output[normalized] = value;
  }
  if (request) output.authorization = 'Bearer PROXY_MANAGED';
  return output;
}

function decodeChunk(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new Error('data must be base64 encoding at most 64 KiB');
  }
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > MAX_CHUNK_BYTES || buffer.toString('base64') !== data) {
    throw new Error('data must be canonical base64 encoding at most 64 KiB');
  }
  return buffer;
}

function networkError(error) {
  const code = error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
    ? ` (${error.code})` : '';
  return `Local upstream request failed${code}`;
}

class LocalBroker {
  constructor({
    upstreamOrigin = 'http://127.0.0.1:2900',
    idleTimeoutMs = 180000,
    maxRequestBytes = 33554432,
    maxQueuedBytes = 1048576,
  } = {}) {
    this.origin = parseOrigin(upstreamOrigin);
    this.upstreamOrigin = this.origin.origin;
    this.idleTimeoutMs = positiveInteger(idleTimeoutMs, 'idleTimeoutMs');
    this.maxRequestBytes = positiveInteger(maxRequestBytes, 'maxRequestBytes');
    this.maxQueuedBytes = positiveInteger(maxQueuedBytes, 'maxQueuedBytes');
    this.sessions = new Map();
    this.disposed = false;
  }

  begin({ method, path, headers = {} } = {}, trustedLocalHeaders) {
    if (this.disposed) throw new Error('Local broker is disposed');
    if (typeof method !== 'string' || typeof path !== 'string' ||
        !ALLOWED_ROUTES.has(`${method} ${path}`)) {
      throw new Error('Unsupported request method or path');
    }
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('Too many active requests (maximum 8)');
    const outgoingHeaders = filterHeaders(headers, true);
    // This second argument is supplied inside the LOCAL extension only. It is
    // never accepted as part of the remote command's serialized request DTO.
    if (trustedLocalHeaders !== undefined) {
      if (!trustedLocalHeaders || typeof trustedLocalHeaders !== 'object' || Array.isArray(trustedLocalHeaders)) {
        throw new Error('Invalid local authentication headers');
      }
      for (const [name, value] of Object.entries(trustedLocalHeaders)) {
        const normalized = name.toLowerCase();
        if (!['authorization', 'chatgpt-account-id'].includes(normalized) || typeof value !== 'string') {
          throw new Error('Invalid local authentication headers');
        }
        try { http.validateHeaderValue(normalized, value); }
        catch { throw new Error('Invalid local authentication headers'); }
        outgoingHeaders[normalized] = value;
      }
    }
    // Content-Length is intentionally removed because the body arrives in
    // chunks. Node does not enable chunked framing for GET by default; without
    // this, a GET body would be parsed upstream as another HTTP message.
    outgoingHeaders['transfer-encoding'] = 'chunked';
    const session = {
      id: randomUUID(), request: null, response: null,
      requestBytes: 0, ended: false, done: false, cancelled: false, error: null,
      queue: [], queuedBytes: 0, readWaiters: new Set(), writeWaiters: new Set(),
      pendingWrite: null, idleTimer: null, headersSettled: false,
    };
    // Always fulfill this promise, even when end() is never called.
    session.headerPromise = new Promise(resolve => { session.resolveHeaders = resolve; });
    const transport = this.origin.protocol === 'https:' ? https : http;
    try {
      session.request = transport.request(new URL(path, this.origin), {
        method, headers: outgoingHeaders, agent: false,
      });
    } catch {
      throw new Error('Unable to create local upstream request');
    }
    this.sessions.set(session.id, session);
    const req = session.request;
    req.setTimeout(this.idleTimeoutMs, () => this._fail(session, 'Local upstream socket inactivity timeout'));
    req.on('error', error => this._fail(session, networkError(error)));
    req.on('close', () => {
      if (!session.headersSettled && !session.done) this._fail(session, 'Local upstream closed before response headers');
    });
    req.on('response', res => {
      if (session.cancelled || session.error) {
        res.destroy();
        return;
      }
      session.response = res;
      this._settleHeaders(session, {
        status: res.statusCode || 502,
        headers: filterHeaders(res.headers, false),
      });
      this._touch(session);
      res.on('data', chunk => {
        if (session.done) return;
        session.queue.push(chunk);
        session.queuedBytes += chunk.length;
        this._touch(session);
        if (session.queuedBytes >= this.maxQueuedBytes) res.pause();
        this._wakeReaders(session);
      });
      res.on('end', () => {
        session.done = true;
        this._touch(session);
        this._wakeReaders(session);
      });
      res.on('aborted', () => this._fail(session, 'Local upstream response was aborted'));
      res.on('error', error => this._fail(session, networkError(error)));
      res.on('close', () => {
        if (!res.complete && !session.done) this._fail(session, 'Local upstream response closed prematurely');
      });
    });
    this._touch(session);
    return { id: session.id };
  }

  async write({ id, data } = {}) {
    const session = this._get(id);
    if (session.error) throw new Error(session.error);
    if (session.ended || session.done) throw new Error('Request body is already closed');
    if (session.pendingWrite) throw new Error('A request body write is already pending');
    const chunk = decodeChunk(data);
    if (session.requestBytes + chunk.length > this.maxRequestBytes) {
      this._fail(session, 'Request body exceeds maxRequestBytes');
      throw new Error(session.error);
    }
    session.requestBytes += chunk.length;
    this._touch(session);
    let settleWrite;
    const pending = new Promise((resolve, reject) => {
      settleWrite = error => error ? reject(new Error(error)) : resolve();
    });
    // end() may wait for the drain; cancellation must also settle it immediately.
    pending.catch(() => {});
    session.pendingWrite = pending;
    const req = session.request;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      req.removeListener('drain', onDrain);
      req.removeListener('close', onClose);
      session.writeWaiters.delete(finish);
      session.pendingWrite = null;
      settleWrite(error);
    };
    const onDrain = () => finish(session.error);
    const onClose = () => finish(session.error || 'Local upstream request closed during write');
    req.once('drain', onDrain);
    req.once('close', onClose);
    session.writeWaiters.add(finish);
    try {
      if (req.write(chunk)) finish(session.error);
    } catch (error) {
      this._fail(session, networkError(error));
      finish(session.error);
    }
    await pending;
    return { ok: true };
  }

  async end({ id } = {}) {
    const session = this._get(id);
    this._touch(session);
    if (!session.ended) {
      session.ended = true;
      const finish = () => {
        if (session.error || session.cancelled) return;
        try { session.request.end(); } catch (error) { this._fail(session, networkError(error)); }
      };
      if (session.pendingWrite) session.pendingWrite.then(finish, () => {});
      else finish();
    }
    const result = await session.headerPromise;
    if (result.error) throw new Error(result.error);
    return result;
  }

  async read({ id, maxBytes = MAX_CHUNK_BYTES, waitMs = 0 } = {}) {
    const session = this._get(id);
    positiveInteger(maxBytes, 'maxBytes');
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new Error('waitMs must be a nonnegative integer');
    maxBytes = Math.min(MAX_CHUNK_BYTES, maxBytes);
    waitMs = Math.min(1000, waitMs);
    this._touch(session);
    if (!session.queuedBytes && !session.done && waitMs) {
      await new Promise(resolve => {
        let timer;
        const wake = () => {
          clearTimeout(timer);
          session.readWaiters.delete(wake);
          resolve();
        };
        session.readWaiters.add(wake);
        timer = setTimeout(wake, waitMs);
      });
    }
    const chunks = [];
    let bytes = 0;
    while (session.queue.length && bytes < maxBytes) {
      const chunk = session.queue[0];
      const take = Math.min(chunk.length, maxBytes - bytes);
      chunks.push(chunk.subarray(0, take));
      if (take === chunk.length) session.queue.shift();
      else session.queue[0] = chunk.subarray(take);
      bytes += take;
      session.queuedBytes -= take;
    }
    if (session.response && !session.done && session.queuedBytes < this.maxQueuedBytes) {
      session.response.resume();
    }
    const done = session.done && !session.queuedBytes;
    const result = { data: Buffer.concat(chunks, bytes).toString('base64'), done };
    if (done && session.error) result.error = session.error;
    return result;
  }

  cancel({ id } = {}) {
    const session = this.sessions.get(id);
    if (session) {
      session.cancelled = true;
      this._clearIdle(session);
      this._fail(session, 'Request cancelled');
      session.queue = [];
      session.queuedBytes = 0;
      this.sessions.delete(id);
    }
    return { ok: true };
  }

  status() {
    return {
      protocolVersion: 1,
      upstreamOrigin: this.upstreamOrigin,
      activeRequests: this.sessions.size,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.sessions.keys()) this.cancel({ id });
  }

  _get(id) {
    if (this.disposed) throw new Error('Local broker is disposed');
    const session = this.sessions.get(id);
    if (!session) throw new Error('Unknown request id');
    return session;
  }

  _settleHeaders(session, result) {
    if (session.headersSettled) return;
    session.headersSettled = true;
    session.resolveHeaders(result);
  }

  _wakeReaders(session) {
    for (const wake of [...session.readWaiters]) wake();
  }

  _clearIdle(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  _touch(session) {
    this._clearIdle(session);
    if (session.cancelled || this.disposed) return;
    session.idleTimer = setTimeout(() => {
      if (session.done) this.cancel({ id: session.id });
      else this._fail(session, 'Request inactivity timeout');
    }, this.idleTimeoutMs);
    session.idleTimer.unref();
  }

  _fail(session, message) {
    if (session.error) return;
    session.error = message;
    session.done = true;
    this._clearIdle(session);
    this._settleHeaders(session, { error: message });
    this._wakeReaders(session);
    for (const finish of [...session.writeWaiters]) finish(message);
    if (session.response) session.response.destroy();
    if (session.request) session.request.destroy();
    this._touch(session);
  }
}

module.exports = { LocalBroker, parseOrigin };
