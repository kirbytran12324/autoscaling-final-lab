// Run against a production web server, API, and simulator serving sample-32-002.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';

const base = new URL(process.env.REPLAY_CHECK_URL || 'http://localhost:8080');
const assetBase = new URL(process.env.REPLAY_ASSET_URL ||
  'http://127.0.0.1:4174/c0f6bfc-2026-10-05/');
if (!assetBase.pathname.endsWith('/')) throw new Error('REPLAY_ASSET_URL must end with /');
const output = fileURLToPath(new URL('../../.validation/', import.meta.url));
await mkdir(output, {recursive: true});
const browser = await chromium.launch({headless: true,
  ...(process.env.REPLAY_CHECK_BROWSER ? {channel: process.env.REPLAY_CHECK_BROWSER} : {})});
const context = await browser.newContext({viewport: {width: 1440, height: 1080}});
const page = await context.newPage();
const errors = [], external = [], assetRequests = [], policyWarnings = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', event => {if (event.type() === 'error') errors.push(event.text());});
page.on('console', event => {
  if (/file:\/\/\/|sandbox.*(escape|remove)|[xX]-[fF]rame-[oO]ptions.*frame-ancestors/.test(event.text())) {
    policyWarnings.push(event.text());
  }
});
page.on('request', request => {
  if (request.url().startsWith('data:')) return;
  const url = new URL(request.url());
  if (url.origin === base.origin) return;
  const isAsset = url.origin === assetBase.origin && url.pathname.startsWith(assetBase.pathname);
  (isAsset ? assetRequests : external).push({type: request.resourceType(), url: request.url()});
});
const player = () => page.frames().find(frame => new URL(frame.url() || base).pathname === '/showdown/player.html');
const waitTurn = turn => player().waitForFunction(value =>
  document.querySelector('#position')?.textContent.includes(`Turn ${value} of`), turn);
const selectMatch = async matchId => {
  await page.getByRole('row', {name: `Open details for ${matchId}`}).click();
  await page.getByRole('button', {name: 'Watch replay', exact: true}).click();
};
const open = async matchId => {
  await selectMatch(matchId);
  await page.getByText('Verified against the saved result').waitFor();
  await page.frameLocator('.replay-frame').locator('#play:not([disabled])').waitFor();
  return page.frameLocator('.replay-frame');
};
const waitGraphics = () => player().waitForFunction(() =>
  Array.from(document.querySelectorAll('.battle img')).filter(image =>
    /\/sprites\/(ani|gen)/.test(image.src) && image.complete && image.naturalWidth > 0).length >= 2,
null, {timeout: 30000});

try {
  const playerResponse = await context.request.get(new URL('/showdown/player.html', base).href);
  assert.equal(playerResponse.headers()['x-frame-options'], undefined);
  assert.match(playerResponse.headers()['content-security-policy'], /frame-ancestors 'self'/);
  assert.match(playerResponse.headers()['content-security-policy'], /sandbox allow-scripts;/);
  assert.equal((await context.request.get(new URL('/index.html', base).href)).headers()['x-frame-options'], 'DENY');
  assert.equal((await context.request.get(new URL('/showdown/missing.js', base).href)).status(), 404);
  await page.goto(new URL('/runs/sample-32-002', base).href);
  await page.getByText(/Search and browse \d+ accepted simulations/).click();

  // Hold the first browser request so closing exercises cancellation before a response.
  let release, intercepted;
  const pending = new Promise(resolve => {release = resolve;});
  const routed = new Promise(resolve => {intercepted = resolve;});
  const delayedReplay = async route => {
    intercepted(); await pending;
    await route.continue().catch(() => {}); // The closed dialog may have aborted it.
  };
  await page.route('**/matches/group-A-000001/replay', delayedReplay);
  await selectMatch('group-A-000001'); await routed;
  await page.getByRole('button', {name: 'Close replay'}).click();
  assert.equal(await page.locator('dialog').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Watch replay');
  release(); await page.unroute('**/matches/group-A-000001/replay', delayedReplay);

  const frame = await open('group-A-000001');
  assert.equal(await player().evaluate(() => {
    try { return !parent.document; } catch { return true; }
  }), true, 'Replay scripts must not access the parent document');
  assert.equal(await player().evaluate(() => BattleSound.muted), true);
  assert.equal(await frame.locator('#play').innerText(), 'Play');
  await frame.locator('#next').click(); await waitTurn(1); await waitGraphics();
  await page.screenshot({path: path.join(output, 'replay-desktop.png')});
  await frame.locator('#previous').click(); await waitTurn(0);
  await frame.locator('#turn').fill('3'); await frame.locator('#turn').press('Enter'); await waitTurn(3);
  const near = await frame.locator('.trainer-near').innerText();
  await frame.locator('#sides').click();
  assert.notEqual(await frame.locator('.trainer-near').innerText(), near);
  await frame.locator('#sound').check(); assert.equal(await player().evaluate(() => BattleSound.muted), false);
  await frame.locator('#reset').click(); await waitTurn(0);
  await frame.locator('#play').click();
  await player().waitForFunction(() => Object.values(BattleSound.soundCache).some(sound =>
    sound && !sound.paused && sound.currentTime > 0),
    null, {timeout: 30000});
  await frame.locator('#play').click(); assert.equal(await frame.locator('#play').innerText(), 'Play');
  await frame.locator('#sound').uncheck(); assert.equal(await player().evaluate(() => BattleSound.muted), true);
  await frame.locator('#speed').selectOption('hyperfast');
  await frame.locator('#play').click();
  await player().waitForFunction(() => document.querySelector('#position')?.textContent.includes('Battle finished'),
    null, {timeout: 20000});
  assert.match(await frame.locator('.battle-log').innerText(), /p2.*won the battle/i);
  await page.getByRole('button', {name: 'Close replay'}).click();
  assert.equal(await page.locator('dialog').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Watch replay');

  // Exercise lifecycle disposal before closing destroys the opaque frame's realm.
  const playing = await open('group-A-000001');
  await playing.locator('#sound').check(); await playing.locator('#play').click();
  await player().waitForFunction(() => Object.values(BattleSound.soundCache).some(sound =>
    sound && !sound.paused && sound.currentTime > 0));
  assert.equal(await player().evaluate(() => {
    const sounds = Object.values(BattleSound.soundCache);
    dispatchEvent(new Event('pagehide'));
    return sounds.every(sound => !sound || sound.paused);
  }), true);
  const playingFrame = player();
  await page.getByRole('button', {name: 'Close replay'}).click();
  assert.equal(playingFrame.isDetached(), true);

  await page.setViewportSize({width: 375, height: 812});
  const mobile = await open('group-A-000002');
  await mobile.locator('#next').click(); await waitTurn(1); await waitGraphics();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await player().evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path: path.join(output, 'replay-mobile.png')});
  await mobile.locator('#next').focus(); await page.keyboard.press('Tab');
  assert.equal(await player().evaluate(() => document.activeElement.id), 'sides');
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog'));
  assert.ok(assetRequests.some(request => request.type === 'image'), 'Expected graphics from the configured asset host');
  assert.ok(assetRequests.some(request => request.type === 'media'), 'Expected audio from the configured asset host');
  assert.deepEqual(external, [], 'Only the configured replay asset host may receive cross-origin requests');
  assert.deepEqual(errors, []);
  assert.deepEqual(policyWarnings, [], 'Replay must not trigger file URL or framing policy warnings');
  console.log(JSON.stringify({verified: true, controls: 'all passed', cancellation: true,
    desktop: true, mobile: true, headers: 'passed', assetRequests: assetRequests.length,
    assetTypes: [...new Set(assetRequests.map(request => request.type))], externalRequests: external.length,
    errors}));
} catch (error) {
  console.error(JSON.stringify({error: error.stack, errors, assets: assetRequests.slice(-4),
    external: external.slice(-4)}));
  await page.screenshot({path: path.join(output, 'replay-error.png')});
  process.exitCode = 1;
} finally {
  await browser.close();
}
