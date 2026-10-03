'use strict';

// Maintenance only: normal web builds use the committed snapshot and need no simulator.
const fs = require('node:fs');
const path = require('node:path');
const base = '../../simulator/node_modules/pokemon-showdown';
const {Dex} = require(`${base}/dist/sim/dex`);
const {version} = require(`${base}/package.json`);
if (version !== '0.11.11') throw new Error('Snapshot requires pokemon-showdown@0.11.11');
const table = entries => Object.fromEntries(entries.map(entry => [entry.id, entry]));
const text = {};
for (const name of ['default', 'moves', 'abilities', 'items', 'pokedex']) {
  const exports = require(`${base}/dist/data/text/${name}`);
  text[name === 'default' ? 'Default' : name[0].toUpperCase() + name.slice(1)] = Object.values(exports)[0];
}
const data = {BattlePokedex: table(Dex.species.all()), BattleMovedex: table(Dex.moves.all()),
  BattleAbilities: table(Dex.abilities.all()), BattleItems: table(Dex.items.all()),
  BattleTypeChart: Dex.data.TypeChart, BattleAliases: Dex.data.Aliases, BattleText: {en: text}};
const destination = path.join(__dirname, '../vendor/showdown/source');
fs.writeFileSync(path.join(destination, 'snapshots/battle-data.json'), `${JSON.stringify(data)}\n`);
fs.mkdirSync(path.join(destination, 'server'), {recursive: true});
fs.copyFileSync(require.resolve(`${base}/server/chat-formatter.ts`), path.join(destination, 'server/chat-formatter.ts'));
fs.copyFileSync(require.resolve(`${base}/LICENSE`), path.join(destination, 'server/LICENSE'));
console.log('Snapshotted the pinned simulator data and MIT formatter.');
