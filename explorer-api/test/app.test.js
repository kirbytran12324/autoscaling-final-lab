'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');

const {createApp, MAX_PAGE_SIZE} = require('../src/app');
const {FilesystemArtifactStore} = require('../src/artifact-store');
const {FIXTURE_RUN_ID, createFixtureRoot, removeFixtureRoot} = require('./helpers');

async function withApi(t) {
  const root = await createFixtureRoot();
  const logs = [];
  const store = new FilesystemArtifactStore({stateRoot: root});
  const app = createApp({
    store,
    logger: {error: (...args) => logs.push(args)},
  });
  t.after(() => removeFixtureRoot(root));
  return {request: (path, method = 'GET') => invoke(app, path, method), logs};
}

async function invoke(app, url, method = 'GET') {
  const chunks = [];
  const response = {
    headersSent: false,
    status: null,
    headers: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body) {
      if (body !== undefined) chunks.push(Buffer.from(body));
    },
    destroy() {
      this.destroyed = true;
    },
  };
  await app({url, method}, response);
  response.body = Buffer.concat(chunks);
  response.json = () => JSON.parse(response.body.toString('utf8'));
  response.text = () => response.body.toString('utf8');
  return response;
}

test('API exposes run detail, standings, bracket, matches and match detail', async t => {
  const {request} = await withApi(t);
  for (const [path, key] of [
    ['/api/runs', 'runs'],
    [`/api/runs/${FIXTURE_RUN_ID}`, 'run'],
    [`/api/runs/${FIXTURE_RUN_ID}/standings`, 'standings'],
    [`/api/runs/${FIXTURE_RUN_ID}/bracket`, 'bracket'],
  ]) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.ok(response.json()[key]);
  }

  const page = (await request(
    `/api/runs/${FIXTURE_RUN_ID}/matches?limit=1&q=blastoise&stage=Group%20stage&result=win&sort=turns&direction=desc`
  )).json();
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  const detailResponse = await request(
    `/api/runs/${FIXTURE_RUN_ID}/matches/${page.items[0].matchId}`
  );
  assert.equal(detailResponse.status, 200);
  assert.equal(detailResponse.json().match.matchId, page.items[0].matchId);
});

test('API serves the offline report as an attachment', async t => {
  const {request} = await withApi(t);
  const response = await request(`/api/runs/${FIXTURE_RUN_ID}/report`);
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(
    response.headers['content-disposition'],
    `attachment; filename="${FIXTURE_RUN_ID}-report.html"`
  );
  assert.match(response.text(), /^<!doctype html>/);
});

test('API returns structured safe errors and enforces its page-size limit', async t => {
  const {request} = await withApi(t);
  for (const [path, status, code] of [
    ['/api/runs/UPPERCASE', 400, 'INVALID_RUN_ID'],
    ['/api/runs/missing-run', 404, 'RUN_NOT_FOUND'],
    [`/api/runs/${FIXTURE_RUN_ID}/matches?limit=${MAX_PAGE_SIZE + 1}`, 400, 'INVALID_LIMIT'],
    [`/api/runs/${FIXTURE_RUN_ID}/matches?cursor=not-a-cursor`, 400, 'INVALID_CURSOR'],
    [`/api/runs/${FIXTURE_RUN_ID}/matches?result=draw`, 400, 'INVALID_QUERY'],
    [`/api/runs/${FIXTURE_RUN_ID}/matches?sort=duration`, 400, 'INVALID_QUERY'],
    [`/api/runs/${FIXTURE_RUN_ID}/matches?unknown=value`, 400, 'INVALID_QUERY'],
    [`/api/runs/${FIXTURE_RUN_ID}/standings?group=Z`, 400, 'INVALID_GROUP'],
    ['/api/not-real', 404, 'NOT_FOUND'],
  ]) {
    const response = await request(path);
    assert.equal(response.status, status, path);
    const payload = response.json();
    assert.deepEqual(Object.keys(payload), ['error']);
    assert.equal(payload.error.code, code);
    assert.equal(payload.error.message.includes('/tmp/'), false);
  }

  const response = await request('/api/runs', 'POST');
  assert.equal(response.status, 405);
  assert.equal(response.json().error.code, 'METHOD_NOT_ALLOWED');
});
