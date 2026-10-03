'use strict';
(function () {
  const replayId = new URLSearchParams(location.search).get('replayId');
  const send = (type, fields = {}) => parent.postMessage({type: `metronome-replay:${type}`, replayId, ...fields}, location.origin);
  const element = id => document.getElementById(id);
  let battle;
  let initializing = false;
  let maxTurn = 0;
  const resize = () => {
    document.querySelector('.battle-stage').style.height = `${360 * Math.min(1, innerWidth / 640)}px`;
    send('resize', {height: Math.ceil(document.querySelector('.player-layout').getBoundingClientRect().height)});
  };
  const update = () => {
    if (!battle) return;
    element('play').textContent = battle.paused ? 'Play' : 'Pause';
    element('position').textContent = `Turn ${Math.max(0, battle.turn)} of ${maxTurn}${battle.ended ? ' · Battle finished' : ''}`;
  };
  async function styles(assetBase) {
    for (const name of ['battle-log.css', 'battle.css', 'replay.css', 'utilichart.css']) {
      const url = new URL(`vendor/style/${name}`, location.href);
      const response = await fetch(url);
      if (!response.ok) throw new Error('Styles unavailable');
      const css = (await response.text()).replace(/url\((['"]?)([^)'"\s]+)\1\)/g, (_, quote, value) => {
        const destination = value.startsWith('../fx/') || value.startsWith('../sprites/')
          ? new URL(value.slice(3), assetBase) : new URL(value, url);
        return `url("${destination.href}")`;
      });
      const style = document.createElement('style');
      style.textContent = css;
      // Keep our responsive layout overrides after the upstream styles.
      document.head.insertBefore(style, document.querySelector('link'));
    }
  }
  addEventListener('message', async event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.replayId !== replayId) return;
    if (event.data.type === 'metronome-replay:ping') { send('ready'); return; }
    if (event.data.type !== 'metronome-replay:init' || initializing || battle) return;
    const replay = event.data.replay;
    if (replay?.verified !== true || typeof replay.log !== 'string' ||
        typeof replay.matchId !== 'string' || replay.log.length > 1024 * 1024) return;
    initializing = true;
    try {
      const assetBase = new URL(event.data.assetBaseUrl);
      if (assetBase.protocol !== 'https:' || assetBase.username || assetBase.password || assetBase.search || assetBase.hash) {
        throw new Error('Invalid graphics host');
      }
      if (!assetBase.pathname.endsWith('/')) assetBase.pathname += '/';
      await styles(assetBase);
      Config.routes.client = `${assetBase.host}${assetBase.pathname}`.replace(/\/$/, '');
      Dex.resourcePrefix = assetBase.href;
      Dex.fxPrefix = new URL('fx/', assetBase).href;
      Dex.loadedSpriteData = {xy: 1, bw: 1};
      maxTurn = Math.max(0, ...Array.from(replay.log.matchAll(/^\|turn\|(\d+)$/gm), match => Number(match[1])));
      element('turn').max = String(maxTurn);
      battle = new Battle({id: replay.matchId, $frame: $('.battle'), $logFrame: $('.battle-log'),
        log: replay.log.split('\n'), isReplay: true, paused: true, autoresize: true});
      battle.setMute(true);
      battle.subscribe(state => { if (state === 'error') send('error'); update(); });
      for (const button of document.querySelectorAll('button')) button.disabled = false;
      resize(); update(); send('loaded');
    } catch (error) {
      element('position').textContent = 'Battle player unavailable. Close this player or retry from the replay dialog.';
      send('error');
      console.error('Battle player initialization failed', error);
    }
  });
  const action = callback => () => {
    if (!battle) return;
    try { callback(); update(); } catch (error) {send('error'); console.error('Battle playback failed', error);}
  };
  element('play').addEventListener('click', action(() => battle.paused ? battle.play() : battle.pause()));
  element('reset').addEventListener('click', action(() => {battle.reset(); battle.pause();}));
  element('previous').addEventListener('click', action(() => {battle.pause(); battle.seekBy(-1);}));
  element('next').addEventListener('click', action(() => {battle.pause(); battle.seekBy(1);}));
  element('sides').addEventListener('click', action(() => battle.switchViewpoint()));
  const seek = () => {
    const turn = Number(element('turn').value);
    if (Number.isInteger(turn) && turn >= 0 && turn <= maxTurn) action(() => {battle.pause(); battle.seekTurn(turn);})();
  };
  element('seek').addEventListener('click', seek);
  element('turn').addEventListener('keydown', event => {if (event.key === 'Enter') {event.preventDefault(); seek();}});
  element('speed').addEventListener('change', action(() => {
    const settings = {normal: [1, 300], fast: [1, 50], hyperfast: [1, 40], slow: [1000, 500]};
    [battle.messageShownTime, battle.messageFadeTime] = settings[element('speed').value];
    battle.scene.updateAcceleration();
  }));
  element('sound').addEventListener('change', action(() => battle.setMute(!element('sound').checked)));
  addEventListener('keydown', event => {if (event.key === 'Escape') {event.preventDefault(); send('escape');}});
  addEventListener('resize', resize);
  addEventListener('pagehide', () => {if (battle) {battle.pause(); battle.setMute(true); battle.destroy(); battle = null;}});
  document.addEventListener('error', event => {
    if (event.target instanceof HTMLImageElement) element('asset-status').hidden = false;
  }, true);
  new ResizeObserver(resize).observe(document.querySelector('.player-layout'));
  resize(); send('ready');
})();
