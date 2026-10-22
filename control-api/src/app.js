'use strict';
const {ControlError} = require('./errors');
const {createAuthenticator, checkBrowserRequest, logout} = require('./auth');

function createApp({manager, token, auth = {mode: 'bearer', token}, verifier, maxConcurrency, readiness = async () => true, logger = console}) {
  const authenticate = createAuthenticator(auth, verifier);
  const windows = new Map();
  return async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, {'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url, 'http://control.local');
      if (request.method === 'GET' && ['/health/live', '/health/ready'].includes(url.pathname)) {
        const ready = url.pathname.endsWith('/live') || await readiness();
        return send(ready ? 200 : 503, {status: ready ? 'ok' : 'not-ready'});
      }
      if (auth.mode === 'alb' && url.pathname === '/auth/logout' && request.method === 'POST') {
        checkBrowserRequest(request, auth);
        return send(200, logout(response, auth));
      }
      const identity = await authenticate(request);
      checkBrowserRequest(request, auth);
      if (request.method === 'POST') {
        const key = request.socket.remoteAddress;
        const now = Date.now();
        const window = windows.get(key);
        if (!window || now - window.start > 60000) windows.set(key, {start: now, count: 1});
        else if (++window.count > 20) throw new ControlError(429, 'RATE_LIMITED', 'Too many control requests. Try again in a minute.');
        if (windows.size > 1000) for (const [address, item] of windows) if (now - item.start > 60000) windows.delete(address);
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'api' || parts[1] !== 'control') throw new ControlError(404, 'NOT_FOUND', 'Endpoint was not found.');
      // Reject noncanonical variants after authentication; never normalize a
      // path into a control operation that listener rules might not protect.
      if (url.pathname !== request.url.split('?')[0] || !/^\/api\/control\/[a-z0-9/-]+$/.test(url.pathname) ||
          url.pathname.includes('//') || url.pathname.endsWith('/')) {
        throw new ControlError(404, 'NOT_FOUND', 'Endpoint was not found.');
      }
      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'session') return send(200, {...identity, maxConcurrency});
      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'options') return send(200, {maxConcurrency});
      if (parts[2] !== 'runs') throw new ControlError(404, 'NOT_FOUND', 'Endpoint was not found.');
      if (request.method === 'GET' && parts.length === 3) return send(200, {runs: await manager.list()});
      if (request.method === 'POST' && parts.length === 3) {
        if (!request.headers['content-type']?.startsWith('application/json')) throw new ControlError(415, 'JSON_REQUIRED', 'Use application/json.');
        let body = '', size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 4096) throw new ControlError(413, 'BODY_TOO_LARGE', 'Run request is too large.');
          body += chunk;
        }
        let value;
        try { value = JSON.parse(body); } catch { throw new ControlError(400, 'INVALID_JSON', 'Request body is not valid JSON.'); }
        return send(202, {run: await manager.create(value)});
      }
      const id = parts[3];
      if (!id || !/^[a-z0-9-]{1,40}$/.test(id)) throw new ControlError(400, 'INVALID_RUN_ID', 'Invalid run ID.');
      if (request.method === 'GET' && parts.length === 4) return send(200, {run: await manager.status(id)});
      if (request.method === 'GET' && parts.length === 5 && parts[4] === 'logs') return send(200, await manager.logs(id));
      if (request.method === 'POST' && parts.length === 5) return send(202, {run: await manager.action(id, parts[4])});
      throw new ControlError(405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.');
    } catch (error) {
      const safe = error instanceof ControlError ? error : new ControlError(503, 'CONTROL_UNAVAILABLE', 'Control service is temporarily unavailable.');
      if (safe.status >= 500) logger.error('Control request failed', {code: safe.code});
      if (!response.headersSent) send(safe.status, {error: {code: safe.code, message: safe.message}});
    }
  };
}
module.exports = {createApp};
