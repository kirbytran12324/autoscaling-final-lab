'use strict';
window.ShowdownAssetBase = (() => {
  const value = new URLSearchParams(location.search).get('assetBaseUrl');
  if (!value) throw new Error('Graphics host is not configured');
  const url = new URL(value, location.origin);
  const sameOrigin = url.origin === location.origin;
  const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
  const allowedTransport = url.protocol === 'https:' ||
    (url.protocol === 'http:' && (sameOrigin || loopback));
  if (!allowedTransport ||
      url.username || url.password || url.search || url.hash) throw new Error('Invalid graphics host');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
})();
window.Config = {routes: {client: 'play.pokemonshowdown.com', dex: 'dex.pokemonshowdown.com',
  root: 'pokemonshowdown.com', replays: 'replay.pokemonshowdown.com'},
server: {id: 'showdown', registered: true}, testclient: true};
Config.routes.client = new URL(ShowdownAssetBase).host + new URL(ShowdownAssetBase).pathname.replace(/\/$/, '');
window.Storage = {prefs: name => name === 'language' ? 'en' : undefined};
