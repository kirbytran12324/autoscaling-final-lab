export const SHOWDOWN_ASSET_RELEASE = 'c0f6bfc-2026-10-05';

function isLoopback(url: URL) {
  return ['127.0.0.1', 'localhost'].includes(url.hostname);
}

export function showdownAssetBaseUrl(value = window.METRONOME_CONFIG?.showdownAssetBaseUrl) {
  const raw = value?.trim();
  if (!raw) throw new Error('Showdown asset base URL is not configured');
  const url = new URL(raw, window.location.origin);
  const isSameOrigin = url.origin === window.location.origin;
  const allowedTransport = url.protocol === 'https:' ||
    (url.protocol === 'http:' && (isSameOrigin || isLoopback(url)));
  if (!allowedTransport ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid Showdown asset base URL');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

// Asset configuration must not prevent reading saved evidence or controlling a run.
// The strict resolver above remains the only way to accept an asset destination.
export function showdownAssetConfiguration() {
  try { return {baseUrl: showdownAssetBaseUrl()}; }
  catch { return {baseUrl: null}; }
}

export function toShowdownId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function pokemonSpriteUrl(species: string, speciesId?: string) {
  return `${showdownAssetBaseUrl()}sprites/gen5/${toShowdownId(speciesId || species)}.png`;
}
