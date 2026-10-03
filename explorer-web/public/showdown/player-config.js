'use strict';
window.ShowdownAssetBase = (() => {
  const url = new URL(new URLSearchParams(location.search).get('assetBaseUrl') || 'https://play.pokemonshowdown.com/');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid graphics host');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
})();
window.Config = {routes: {client: 'play.pokemonshowdown.com', dex: 'dex.pokemonshowdown.com',
  root: 'pokemonshowdown.com', replays: 'replay.pokemonshowdown.com'},
server: {id: 'showdown', registered: true}, testclient: true};
Config.routes.client = new URL(ShowdownAssetBase).host + new URL(ShowdownAssetBase).pathname.replace(/\/$/, '');
window.Storage = {prefs: name => name === 'language' ? 'en' : undefined};
