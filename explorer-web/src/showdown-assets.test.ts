import {beforeEach, expect, test} from 'vitest';
import playerConfig from '../public/showdown/player-config.js?raw';
import {pokemonSpriteUrl, showdownAssetBaseUrl, toShowdownId} from './showdown-assets';

beforeEach(() => {
  window.METRONOME_CONFIG = {
    showdownAssetBaseUrl: 'http://127.0.0.1:4174/c0f6bfc-2026-10-05/',
  };
});

test('uses the runtime-configured pinned snapshot and Showdown species IDs', () => {
  expect(showdownAssetBaseUrl()).toBe('http://127.0.0.1:4174/c0f6bfc-2026-10-05/');
  expect(toShowdownId('Mr. Mime')).toBe('mrmime');
  expect(toShowdownId('Farfetch’d')).toBe('farfetchd');
  expect(pokemonSpriteUrl('Mr. Mime')).toBe(
    'http://127.0.0.1:4174/c0f6bfc-2026-10-05/sprites/gen5/mrmime.png');
});

test('allows loopback HTTP and requires HTTPS for other cross-origin hosts', () => {
  expect(showdownAssetBaseUrl('http://localhost:4174/replay'))
    .toBe('http://localhost:4174/replay/');
  expect(() => showdownAssetBaseUrl('http://assets.example.test/replay/')).toThrow();
  expect(showdownAssetBaseUrl('https://assets.example.test/replay'))
    .toBe('https://assets.example.test/replay/');
});

test('rejects missing configuration and URL capabilities', () => {
  delete window.METRONOME_CONFIG;
  expect(() => showdownAssetBaseUrl()).toThrow('not configured');
  window.METRONOME_CONFIG = {
    showdownAssetBaseUrl: 'http://127.0.0.1:4174/c0f6bfc-2026-10-05/',
  };
  expect(() => showdownAssetBaseUrl('https://user@example.test/replay/')).toThrow();
  expect(() => showdownAssetBaseUrl('https://assets.example.test/replay/?token=secret')).toThrow();
});

test.each(['file:///', 'file:///C:/assets/', 'C:\\assets\\', 'javascript:alert(1)'])(
  'rejects filesystem and executable asset URLs in both resolvers: %s', value => {
    expect(() => showdownAssetBaseUrl(value)).toThrow('Invalid Showdown asset base URL');
    const configurePlayer = new Function('window', 'location', 'URL', 'URLSearchParams', playerConfig);
    expect(() => configurePlayer({},
      {origin: window.location.origin, search: `?assetBaseUrl=${encodeURIComponent(value)}`},
      URL, URLSearchParams)).toThrow('Invalid graphics host');
  });
