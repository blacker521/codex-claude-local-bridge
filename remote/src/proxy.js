'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');

const ROUTES = new Map([
  ['/health', 'GET'],
  ['/bridge/auth-check', 'GET'],
  ['/v1/models', 'GET'],
  ['/v1/responses', 'POST'],
  ['/v1/responses/compact', 'POST'],
  ['/v1/messages', 'POST'],
  ['/v1/messages?beta=true', 'POST'],
  ['/v1/messages/count_tokens', 'POST'],
  ['/v1/messages/count_tokens?beta=true', 'POST'],
]);
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'host',
]);

function responseHeaders(headers) {
  const result = {};
  const blocked = new Set(HOP_HEADERS);
  String(headers.connection || '').split(',').forEach(name => blocked.add(name.trim().toLowerCase()));
  for (const [name, value] of Object.entries(headers)) {
    if (!blocked.has(name.toLowerCase()) && value !== undefined) result[name] = value;
  }
  return result;
}

function waitForRpc(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      callback(value);
    };
    const aborted = () => finish(reject, new Error('Bridge request cancelled'));
    // Attach both handlers even after cancellation so a late RPC rejection is
    // always consumed. The underlying editor command itself cannot be aborted.
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(reject, new Error('Bridge RPC inactivity timeout')), timeoutMs);
  });
}

class RemoteProxy {
  constructor({ rpc, token, port = 35721, maxRequestBytes = 32 * 1024 * 1024, rpcTimeoutMs = 180000, log = () => {} }) {
    if (typeof rpc !== 'function') throw new Error('桥接需要 RPC 函数。');
    if (token !== undefined && (typeof token !== 'string' || token.length < 16)) {
      throw new Error('显式桥接访问凭据至少需要 16 个字符。');
    }
    if (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs <= 0 || rpcTimeoutMs > 2147483647) {
      throw new Error('RPC 超时必须是有效的正整数毫秒数。');
    }
    this.rpc = rpc;
    this.token = token === undefined ? undefined : Buffer.from(`Bearer ${token}`);
    this.port = port;
    this.maxRequestBytes = maxRequestBytes;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.log = log;
    this.server = undefined;
    this.pending = new Set();
    this.sockets = new Set();
  }

  async start() {
    if (this.server) return this.address();
    const server = http.createServer((req, res) => {
      const task = this.handle(req, res);
      this.pending.add(task);
      task.catch(() => {}).finally(() => this.pending.delete(task));
    });
    this.server = server;
    server.headersTimeout = 30_000;
    // 模型流持续时间不受 requestTimeout 限制；本机端负责上游空闲超时。
    server.requestTimeout = 0;
    server.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.removeListener('listening', ready); reject(error); };
        const ready = () => { server.removeListener('error', failed); resolve(); };
        server.once('error', failed);
        server.once('listening', ready);
        server.listen(this.port, '127.0.0.1');
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    }
    this.log(`远程桥接已监听 ${this.address().baseUrl}`);
    return this.address();
  }

  address() {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('代理尚未启动。');
    return { port: address.port, baseUrl: `http://127.0.0.1:${address.port}/v1` };
  }

  authenticated(req) {
    if (!this.token) return true;
    const actual = Buffer.from(req.headers.authorization || '');
    return actual.length === this.token.length && crypto.timingSafeEqual(actual, this.token);
  }

  async handle(req, res) {
    let id;
    let cancelled = false;
    const abort = new AbortController();
    const rpc = (method, argument) => waitForRpc(
      Promise.resolve().then(() => this.rpc(method, argument)), this.rpcTimeoutMs, abort.signal,
    );
    const cancel = async () => {
      if (id && !cancelled) {
        cancelled = true;
        await waitForRpc(
          Promise.resolve().then(() => this.rpc('cancel', { id })),
          Math.min(this.rpcTimeoutMs, 5000),
        ).catch(() => {});
      }
    };
    const disconnected = () => {
      if (!res.writableFinished) {
        abort.abort();
        void cancel();
      }
    };
    req.on('aborted', disconnected);
    res.on('close', disconnected);
    try {
      const expected = ROUTES.get(req.url);
      if (!expected) return this.error(res, 404, '该桥接只接受支持的模型 API 路径。');
      if (req.method !== expected) return this.error(res, 405, '不支持该 HTTP 方法。');
      if (req.url !== '/health' && !this.authenticated(req)) {
        this.log(`桥接认证失败：${req.headers.authorization ? 'mismatch' : 'missing'}`);
        return this.error(res, 401, '桥接访问认证无效。');
      }
      if (req.url === '/bridge/auth-check') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(this.token
          ? { authenticated: true }
          : { authenticated: true, authentication: 'local-cc-switch' }));
        return;
      }
      if (Number(req.headers['content-length'] || 0) > this.maxRequestBytes) {
        req.resume();
        return this.error(res, 413, '请求体超出桥接限制。');
      }
      // 服务器上的登录状态不参与认证，供应商凭据由本机统一提供。
      const headers = { ...req.headers };
      delete headers.authorization;
      delete headers['chatgpt-account-id'];
      delete headers['x-api-key'];
      const opening = Promise.resolve().then(() => this.rpc('begin', {
        method: req.method,
        path: req.url,
        headers,
      }));
      // A disconnected client must not leave a session behind when begin's
      // result arrives after this handler has already stopped waiting for it.
      opening.then(opened => {
        if (!opened || typeof opened.id !== 'string') return;
        id = opened.id;
        if (abort.signal.aborted) void cancel();
      }, () => {});
      const opened = await waitForRpc(opening, this.rpcTimeoutMs, abort.signal);
      id = opened.id;
      if (req.aborted || res.destroyed) return;
      let bytes = 0;
      // destroyOnReturn=false 允许超限后仍发送 413，而不是直接重置客户端连接。
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > this.maxRequestBytes) {
          req.resume();
          return this.error(res, 413, '请求体超出桥接限制。');
        }
        for (let offset = 0; offset < chunk.length; offset += 65536) {
          if (res.destroyed) return;
          await rpc('write', { id, data: chunk.subarray(offset, offset + 65536).toString('base64') });
        }
      }
      if (res.destroyed) return;
      const upstream = await rpc('end', { id });
      if (res.destroyed) return;
      res.writeHead(upstream.status, responseHeaders(upstream.headers));
      res.flushHeaders();
      for (;;) {
        if (res.destroyed) return;
        const part = await rpc('read', { id, maxBytes: 65536, waitMs: 1000 });
        if (res.destroyed) return;
        if (part.data) {
          const data = Buffer.from(part.data, 'base64');
          if (!res.write(data)) await once(res, 'drain', { signal: abort.signal });
        }
        if (part.error) throw new Error(part.error);
        if (part.done) { res.end(); return; }
      }
    } catch (error) {
      this.log(`转发失败：${error.code || error.name || 'Error'}`);
      if (!res.headersSent) this.error(res, 502, '本机桥接或上游请求失败，请运行连接诊断。');
      else if (!res.destroyed) res.destroy();
    } finally {
      req.removeListener('aborted', disconnected);
      res.removeListener('close', disconnected);
      abort.abort();
      await cancel();
    }
  }

  error(res, status, message) {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message } }));
  }

  async stop() {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    const closed = new Promise(resolve => server.close(resolve));
    for (const socket of this.sockets) socket.destroy();
    await Promise.allSettled([...this.pending]);
    await closed;
    this.log('远程桥接已停止。');
  }
}

module.exports = { RemoteProxy };
