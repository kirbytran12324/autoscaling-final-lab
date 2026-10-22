import {showdownAssetConfiguration} from './showdown-assets';

export function ShowdownAssetsWarning() {
  if (showdownAssetConfiguration().baseUrl) return null;
  return <p role="status" className="asset-configuration-warning">
    Sprites and animated replays are unavailable. Configure <code>showdownAssetBaseUrl</code> to the
    pinned asset snapshot and reload this page. Tournament data and controls remain available.
  </p>;
}
