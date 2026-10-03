# Pokémon Showdown replay subset

Client source: https://github.com/smogon/pokemon-showdown-client/tree/c0f6bfc707a5e3bba4da3785e9cb06c8ae04f8d9

The battle replay/animation engine is identified by upstream as MIT, independently
of the full AGPLv3 client. Original source headers and copyright notices are retained.
Move animation definitions include CC0 notices. `battle.css` retains its GPLv2
notice; styles without an individual license retain the repository's AGPLv3
license. Original headers and full license texts are included. The vendored source is served
under `source/`, and `manifest.json` identifies and hashes every input.

The MIT simulator formatter and battle data come from pokemon-showdown@0.11.11.
The jQuery 1.11.0 script retains its MIT notice. The Caja sanitizer's Apache-2.0
attribution is supplied below because its upstream minified file has no license
header. Sprite geometry metadata is a frozen snapshot from the
Showdown asset host; the manifest records its URL and retrieval date.

Sprite and audio files are requested from the configured asset host and are not
distributed with this repository. The engine's license does not cover Pokémon
sprites. The source's animation comments document credits and exceptions for fx
artwork. Pokémon and related names are trademarks of their respective owners.

Rebuild: `npm ci --ignore-scripts`, then `npm run build:showdown` in explorer-web.
The build verifies every source checksum and uses the exact compiler versions in
package-lock.json. The build script, package definition, and lock are also served beside
the manifest. No upstream download occurs during a build or at server startup.

To update the simulator data intentionally: install simulator's locked dependency,
run `node scripts/snapshot-showdown-data.cjs`, review the changed data, and update
manifest checksums. Client upgrades require explicit revision and source review.

To rebuild from the files served at `/showdown/vendor/`, reconstruct this layout:
put the `source/` tree, manifest, and notices in `vendor/showdown/`; put
`build-showdown.mjs` and `replay-text.mjs` in `scripts/`; put `package.json` and
`package-lock.json` at the root of that directory. Then use the rebuild commands
above. The generated viewer subset is written to `public/showdown/vendor/`.

## Per-file notices

Paths below are relative to `source/`. The battle engine's original headers
credit Guangcong Luo and other Showdown contributors; those headers are preserved
in the generated engine. Files without individual headers in the battle engine
use upstream's explicit `battle-*.ts` MIT licensing statement.

| File under `play.pokemonshowdown.com/src/` | Notice / license |
| --- | --- |
| `battle.ts` | Guangcong Luo; MIT |
| `battle-animations.ts` | Guangcong Luo; MIT; artwork exceptions in its source comments |
| `battle-animations-moves.ts` | Guangcong Luo; CC0-1.0 |
| `battle-dex-data.ts` | Guangcong Luo; MIT |
| `battle-dex.ts` | Guangcong Luo; MIT |
| `battle-log-misc.js` | Guangcong Luo; MIT |
| `battle-log.ts` | Guangcong Luo; MIT |
| `battle-scene-stub.ts` | Showdown contributors; MIT battle engine subset |
| `battle-sound.ts` | Showdown contributors; MIT battle engine subset |
| `battle-teams.ts` | Showdown contributors; MIT battle engine subset |
| `battle-text-parser.ts` | Guangcong Luo; MIT |
| `battle-tooltips.ts` | Guangcong Luo; MIT |
| `replay-embed.ts` | Guangcong Luo; MIT; reference source, not compiled into this player |

| Other file | Notice / license |
| --- | --- |
| `play.pokemonshowdown.com/style/battle.css` | GPLv2, original header retained |
| `play.pokemonshowdown.com/style/battle-log.css` | Showdown client repository license, AGPLv3 |
| `play.pokemonshowdown.com/style/replay.css` | Showdown client repository license, AGPLv3 |
| `play.pokemonshowdown.com/style/utilichart.css` | Showdown client repository license, AGPLv3 |
| `play.pokemonshowdown.com/js/lib/jquery-1.11.0.min.js` | Copyright 2005, 2014 jQuery Foundation, Inc.; MIT; original header retained |
| `play.pokemonshowdown.com/js/lib/html-sanitizer-minified.js` | Google Caja; Apache-2.0; attribution below |
| `server/chat-formatter.ts` | MIT; Copyright 2011–2026 Guangcong Luo and other contributors; see `server/LICENSE` |
| `snapshots/battle-data.json` | Derived from the same MIT simulator data and English text; see `server/LICENSE` |
| `snapshots/pokedex-mini.js` | Showdown-generated sprite geometry metadata; frozen asset-host snapshot; repository AGPLv3 terms retained |
| `snapshots/pokedex-mini-bw.js` | Showdown-generated sprite geometry metadata; frozen asset-host snapshot; repository AGPLv3 terms retained |
| `LICENSE` | Original client AGPLv3 text |
| `server/LICENSE` | Original simulator MIT text and copyright notice |
| `licenses/Apache-2.0.txt`, `licenses/CC0-1.0.txt`, `licenses/GPL-2.0-only.txt`, `licenses/MIT.txt` | Full supplemental license texts |

Google Caja HTML sanitizer: Copyright (C) 2006 Google Inc. Licensed under the
Apache License, Version 2.0. See `source/licenses/Apache-2.0.txt` and the
[original sanitizer source](https://github.com/googlearchive/caja/blob/master/src/com/google/caja/plugin/html-sanitizer.js).

Local build transformations: TypeScript annotations and module imports/exports
are removed for an isolated classic-script bundle; runtime exports are exposed
inside the player frame; configured HTTPS graphics prefixes are set before
animation initialization. Generated styles omit `@import` declarations because
the player loads each stylesheet explicitly. Frozen simulator text placeholders
are adapted to the pinned client format. Unmodified source and the complete
build code are distributed alongside these outputs.
