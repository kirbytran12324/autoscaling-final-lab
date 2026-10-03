import {readFile, writeFile, mkdir, cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import babel from '@babel/core';
import typescript from '@babel/plugin-transform-typescript';
import removeImports from 'babel-plugin-remove-import-export';
import {normalizeReplayText} from './replay-text.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = path.join(root, 'vendor/showdown');
const source = path.join(vendor, 'source');
const output = path.join(root, 'public/showdown/vendor');
const manifest = JSON.parse(await readFile(path.join(vendor, 'manifest.json'), 'utf8'));
for (const [name, expected] of Object.entries(manifest.sha256)) {
  const actual = createHash('sha256').update(await readFile(path.join(source, name))).digest('hex');
  if (actual !== expected) throw new Error(`Showdown source checksum failed: ${name}`);
}
await mkdir(output, {recursive: true});
const scripts = [
  'battle-dex-data.ts', 'battle-teams.ts', 'battle-text-parser.ts', 'battle-dex.ts',
  'battle-log-misc.js', 'battle-log.ts', 'battle-sound.ts', 'battle-scene-stub.ts',
  'battle-tooltips.ts', 'battle-animations.ts', 'battle-animations-moves.ts', 'battle.ts',
];
let engine = '/* Generated locally from pinned Pokemon Showdown source: TypeScript and modules converted; asset prefixes configured. See NOTICES.md, source/, and build-showdown.mjs. */\nwindow.exports = window;\n';
const compiler = (filename, text, extraExports = []) => {
  const ast = babel.parseSync(text, {filename, babelrc: false, configFile: false,
    plugins: [[typescript, {allowDeclareFields: true}]]});
  const names = [...extraExports];
  for (const node of ast.program.body) {
    if (node.type !== 'ExportNamedDeclaration') continue;
    const declaration = node.declaration;
    if (declaration?.declare) continue;
    if (['ClassDeclaration', 'FunctionDeclaration'].includes(declaration?.type)) names.push(declaration.id.name);
    if (declaration?.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) if (item.id.type === 'Identifier') names.push(item.id.name);
    }
  }
  const compiled = babel.transformFromAstSync(ast, text, {filename, babelrc: false,
    configFile: false, comments: true, compact: true,
    plugins: [[typescript, {allowDeclareFields: true}], removeImports]}).code;
  return `(function(){\n${compiled}\nObject.assign(window,{${names.join(',')}});\n})();\n`;
};
// The formatter is MIT and comes from the same pinned simulator as the saved results.
engine += compiler('chat-formatter.ts', await readFile(path.join(source, 'server/chat-formatter.ts'), 'utf8'));
for (const name of scripts) {
  // MD5 is a non-exported declaration in upstream's classic script.
  engine += compiler(name, await readFile(path.join(source, 'play.pokemonshowdown.com/src', name), 'utf8'),
    name === 'battle-log-misc.js' ? ['MD5'] : []);
  if (name === 'battle-dex.ts') {
    // Upstream uses a scheme-relative fx URL on HTTP pages. Set the configured
    // HTTPS base before animation tables precompute their URLs.
    engine += 'Dex.resourcePrefix=window.ShowdownAssetBase;Dex.fxPrefix=new URL("fx/",window.ShowdownAssetBase).href;\n';
  }
}
await writeFile(path.join(output, 'engine.js'), engine);
const data = JSON.parse(await readFile(path.join(source, 'snapshots/battle-data.json'), 'utf8'));
data.BattleText.en = normalizeReplayText(data.BattleText.en);
await writeFile(path.join(output, 'battle-data.js'), `window.exports=window;Object.assign(window,${JSON.stringify(data)});\n`);
for (const name of ['pokedex-mini.js', 'pokedex-mini-bw.js']) {
  await cp(path.join(source, 'snapshots', name), path.join(output, name));
}
for (const name of ['jquery-1.11.0.min.js', 'html-sanitizer-minified.js']) {
  await cp(path.join(source, 'play.pokemonshowdown.com/js/lib', name), path.join(output, name));
}
await mkdir(path.join(output, 'style'), {recursive: true});
for (const name of ['battle.css', 'battle-log.css', 'replay.css', 'utilichart.css']) {
  const css = await readFile(path.join(source, 'play.pokemonshowdown.com/style', name), 'utf8');
  await writeFile(path.join(output, 'style', name),
    '/* Generated locally: @import declarations removed; styles loaded explicitly by player.js. Original source and license: see source/ and NOTICES.md. */\n' +
    css.replace(/^@import[^;]+;\s*/gm, ''));
}
await cp(source, path.join(output, 'source'), {recursive: true});
await cp(path.join(vendor, 'NOTICES.md'), path.join(output, 'NOTICES.md'));
await cp(path.join(vendor, 'manifest.json'), path.join(output, 'manifest.json'));
await cp(fileURLToPath(import.meta.url), path.join(output, 'build-showdown.mjs'));
await cp(path.join(root, 'scripts/replay-text.mjs'), path.join(output, 'replay-text.mjs'));
await cp(path.join(root, 'package.json'), path.join(output, 'package.json'));
await cp(path.join(root, 'package-lock.json'), path.join(output, 'package-lock.json'));
console.log(`Built pinned Showdown replay engine (${manifest.clientRevision}).`);
