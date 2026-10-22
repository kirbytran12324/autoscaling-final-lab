'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {generateKeyPairSync} = require('node:crypto');
const {createServer, request: httpRequest} = require('node:http');
const {FetchError} = require('aws-jwt-verify/error');
const {readAuthConfig} = require('../src/auth');
const {createApp} = require('../src/app');

const {operator, environment, auth, kid, keys, signed, verifier} = require('./alb-fixture');

test('ALB verifies AWS header-only issuer/expiry and padded claims with a real ES256 signature', async () => {
  const verify = verifier();
  assert.equal((await verify.verify(signed())).sub, operator);
  assert.equal((await verify.verify(signed({}, {sub: operator}, keys.privateKey, true))).sub, operator);
  assert.equal((await verify.verify(signed({exp: String(Math.floor(Date.now() / 1000) + 60)}))).sub, operator);
});

test('rejects expired, missing, forged and wrong algorithm/signer/issuer/client claims', async () => {
  const verify = verifier();
  for (const header of [{exp: 1}, {exp: undefined}, {exp: 'never'}, {iss: 'https://attacker.invalid'},
    {iss: undefined}, {signer: auth.albArn + '0'}, {client: 'another'}, {alg: 'none'}, {alg: 'ES384'}]) {
    await assert.rejects(verify.verify(signed(header)));
  }
  const other = generateKeyPairSync('ec', {namedCurve: 'P-256'});
  await assert.rejects(verify.verify(signed({}, {sub: operator}, other.privateKey)));
  const original = signed();
  const forged = original.split('.');
  forged[1] = Buffer.from(JSON.stringify({sub: 'attacker'})).toString('base64url');
  await assert.rejects(verify.verify(forged.join('.')));
  await assert.rejects(verify.verify('not-a-jwt'));
});

test('key lookup is fixed to configured AWS region with a UUID kid and ignores header URLs', async () => {
  const urls = [];
  const verify = verifier({fetch: async url => {
    urls.push(url);
    return Buffer.from(keys.publicKey.export({format: 'pem', type: 'spki'}));
  }});
  await verify.verify(signed({jku: 'https://attacker.invalid/keys', x5u: 'http://127.0.0.1/private'}));
  assert.deepEqual(urls, [`${auth.jwksUri}/${kid}`]);
  for (const value of ['../escape', 'https://attacker.invalid', 'bad?key']) await assert.rejects(verify.verify(signed({kid: value})));
  assert.equal(urls.length, 1);
});

test('configuration fails closed, requires explicit mode and nonempty operator allowlist', () => {
  assert.throws(() => readAuthConfig({}), /CONTROL_AUTH_MODE/);
  for (const key of Object.keys(environment)) assert.throws(() => readAuthConfig({...environment, [key]: ''}), Error, key);
  for (const change of [{CONTROL_AUTH_MODE: 'auto'}, {CONTROL_ALB_ARN: 'https://attacker.invalid'},
    {CONTROL_COGNITO_ISSUER: 'https://attacker.invalid'}, {CONTROL_OPERATOR_SUBJECTS: ','},
    {CONTROL_ALB_COOKIE_NAME: 'bad;cookie'}, {CONTROL_PUBLIC_ORIGIN: 'http://lab.example'},
    {CONTROL_PUBLIC_ORIGIN: 'https://lab.example/'}, {CONTROL_COGNITO_DOMAIN: 'https://lab.example/path'}]) {
    assert.throws(() => readAuthConfig({...environment, ...change}));
  }
  assert.throws(() => createApp({manager: {}, auth: {mode: 'alb'}}), /configuration/);
  assert.equal(auth.mode, 'alb');
});

test('API authorizes verified subjects, rejects unsigned headers/bearer fallback and protects every control path', async t => {
  let mutations = 0;
  const logger = {error: (...args) => {assert.ok(!JSON.stringify(args).includes('eyJ'));}};
  const server = createServer(createApp({auth, verifier: verifier(), maxConcurrency: 8, logger,
    manager: {list: async () => [], create: async value => {mutations++; return value;}}}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {'x-amzn-oidc-data': signed()};
  assert.deepEqual(await (await fetch(base + '/health/live')).json(), {status: 'ok'});
  for (const path of ['/api/control', '/api/control/', '/api/control/runs', '/api/control/unknown', '/api/control//runs', '/api/control/runs/']) {
    assert.equal((await fetch(base + path, {headers: {authorization: 'Bearer ' + 'x'.repeat(32), 'x-amzn-oidc-identity': operator}})).status, 401, path);
  }
  assert.equal((await fetch(base + '/api/control/session', {headers: {'x-amzn-oidc-data': signed({}, {sub: 'other'})}})).status, 403);
  assert.equal((await fetch(base + '/api/control/session', {headers: {'x-amzn-oidc-data': signed({}, {})}})).status, 401);
  assert.equal((await fetch(base + '/api/control/session', {headers: {'x-amzn-oidc-data': signed({exp: 1})}})).status, 401);
  const session = await fetch(base + '/api/control/session', {headers});
  assert.equal(session.status, 200);
  assert.equal(session.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await session.json(), {mode: 'alb', subject: operator, operator: true, maxConcurrency: 8});
  const mutationHeaders = {...headers, origin: auth.publicOrigin, 'x-control-csrf': '1', 'content-type': 'application/json'};
  // node:http preserves the raw path, unlike fetch/browser URL normalization.
  for (const path of ['/api/control//runs', '/api/control/runs/', '/api/%63ontrol/runs',
    '/x/../api/control/runs', '/api/control/./runs', '/api/control/%2e/runs']) {
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(base, {path, method: 'POST', headers: mutationHeaders}, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject); request.end('{}');
    });
    assert.equal(status, 404, path);
  }
  assert.equal((await fetch(base + '/api/control/runs', {method: 'POST', headers: {...mutationHeaders,
    'x-amzn-oidc-data': signed({}, {sub: 'other'})}, body: '{}'})).status, 403);
  for (const change of [{origin: ''}, {origin: 'https://attacker.invalid'}, {origin: 'http://lab.example'},
    {origin: auth.publicOrigin + '/'}, {'x-control-csrf': ''}, {'sec-fetch-site': 'cross-site'}]) {
    assert.equal((await fetch(base + '/api/control/runs', {method: 'POST', headers: {...mutationHeaders, ...change}, body: '{}'})).status, 403);
  }
  assert.equal(mutations, 0);
  assert.equal((await fetch(base + '/api/control/runs', {method: 'POST', headers: mutationHeaders, body: '{}'})).status, 202);
  assert.equal(mutations, 1);
  const signedOut = await fetch(base + '/auth/logout', {method: 'POST', headers: {origin: auth.publicOrigin, 'x-control-csrf': '1'}});
  assert.equal(signedOut.status, 200);
  assert.equal(signedOut.headers.getSetCookie().length, 6);
  for (const cookie of signedOut.headers.getSetCookie()) assert.match(cookie, /Max-Age=0;.*Secure; HttpOnly/);
  assert.equal((await signedOut.json()).logoutUrl, auth.logoutUrl);
  assert.equal((await fetch(base + '/auth/logout', {method: 'POST'})).status, 403);
  assert.equal(mutations, 1);
});

test('injected verification outages return 503 without leaking raw tokens', async t => {
  const server = createServer(createApp({auth, verifier: {verify: async () => {throw new FetchError('private-token');}},
    manager: {}, maxConcurrency: 8, logger: {error: (_message, value) => assert.deepEqual(value, {code: 'IDENTITY_UNAVAILABLE'})}}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/control/session`, {headers: {'x-amzn-oidc-data': 'private-token'}});
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('private-token'));
});
