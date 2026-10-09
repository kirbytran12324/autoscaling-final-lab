#!/usr/bin/env node
import {createReadStream} from 'node:fs';
import {readFile, realpath, stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const DEFAULT_RELEASE = 'c0f6bfc-2026-10-05';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4174;
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.wav', 'audio/wav'],
  ['.webp', 'image/webp'],
]);

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: node scripts/serve-replay-assets.mjs [--root PATH] [--release NAME] [--host LOOPBACK] [--port NUMBER]');
  process.exit(2);
}

const options = {
  root: path.join(repositoryRoot, '.local-assets', 'showdown'),
  release: DEFAULT_RELEASE,
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!value) usage(`Missing value for ${name}`);
  if (name === '--root') options.root = path.resolve(value);
  else if (name === '--release') options.release = value;
  else if (name === '--host') options.host = value;
  else if (name === '--port') options.port = Number(value);
  else usage(`Unknown option: ${name}`);
}
if (!/^[a-zA-Z0-9._-]+$/.test(options.release)) usage('release contains unsupported characters');
if (!['127.0.0.1', 'localhost'].includes(options.host)) usage('host must be 127.0.0.1 or localhost');
if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) usage('port must be between 1 and 65535');

const releaseRoot = path.resolve(options.root, options.release);
if (path.dirname(releaseRoot) !== path.resolve(options.root)) usage('release must identify one directory below root');
let releaseMetadata;
let physicalReleaseRoot;
try {
  physicalReleaseRoot = await realpath(releaseRoot);
  releaseMetadata = JSON.parse(await readFile(path.join(releaseRoot, 'release.json'), 'utf8'));
} catch (error) {
  console.error(`Unable to read the pinned snapshot metadata: ${error.message}`);
  process.exit(1);
}
if (releaseMetadata.snapshot !== options.release) {
  console.error(`Snapshot metadata names ${releaseMetadata.snapshot}; expected ${options.release}`);
  process.exit(1);
}

function baseHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

function reply(response, status, body, headers = {}) {
  response.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers});
  response.end(body);
}

function parseRange(value, size) {
  if (!value) return {start: 0, end: size - 1, partial: false};
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length <= 0) return null;
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return null;
  return {start, end, partial: true};
}

const server = createServer(async (request, response) => {
  baseHeaders(response);
  if (!['GET', 'HEAD'].includes(request.method)) {
    reply(response, 405, 'method not allowed\n', {Allow: 'GET, HEAD'});
    return;
  }
  const requestUrl = new URL(request.url || '/', 'http://asset-server.local');
  if (requestUrl.pathname === '/health/live') {
    reply(response, 200, request.method === 'HEAD' ? '' : 'ok\n');
    return;
  }
  if (requestUrl.pathname === '/health/ready') {
    const body = JSON.stringify({ready: true, release: options.release}) + '\n';
    response.writeHead(200, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    response.end(request.method === 'HEAD' ? '' : body);
    return;
  }
  const prefix = `/${options.release}/`;
  if (!requestUrl.pathname.startsWith(prefix)) {
    reply(response, 404, 'not found\n');
    return;
  }
  let relative;
  try {
    relative = decodeURIComponent(requestUrl.pathname.slice(prefix.length));
  } catch {
    reply(response, 400, 'invalid path\n');
    return;
  }
  const target = path.resolve(releaseRoot, relative);
  if (!relative || (target !== releaseRoot && !target.startsWith(`${releaseRoot}${path.sep}`))) {
    reply(response, 404, 'not found\n');
    return;
  }
  let details;
  let physicalTarget;
  try {
    physicalTarget = await realpath(target);
    const physicalRelative = path.relative(physicalReleaseRoot, physicalTarget);
    if (physicalRelative === '..' || physicalRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(physicalRelative)) {
      reply(response, 404, 'not found\n');
      return;
    }
    details = await stat(physicalTarget);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      reply(response, 404, 'not found\n');
      return;
    }
    reply(response, 500, 'asset read failed\n');
    return;
  }
  if (!details.isFile() || details.size <= 0) {
    reply(response, 404, 'not found\n');
    return;
  }
  const range = parseRange(request.headers.range, details.size);
  if (!range) {
    reply(response, 416, '', {'Content-Range': `bytes */${details.size}`});
    return;
  }
  response.statusCode = range.partial ? 206 : 200;
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  response.setHeader('Content-Length', String(range.end - range.start + 1));
  response.setHeader('Content-Type', contentTypes.get(path.extname(physicalTarget).toLowerCase()) || 'application/octet-stream');
  if (range.partial) response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${details.size}`);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(physicalTarget, {start: range.start, end: range.end});
  stream.on('error', () => response.destroy());
  stream.pipe(response);
});

server.listen(options.port, options.host, () => {
  console.log(`Replay assets: http://${options.host}:${options.port}/${options.release}/`);
  console.log(`Snapshot root: ${releaseRoot}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
